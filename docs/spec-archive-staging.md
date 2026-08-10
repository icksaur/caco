# spec-archive-staging

## Goals

Make `/caco.session-archive` reversible. Today it removes the session
immediately: the command calls `DELETE /api/sessions/:id`, which exports a
tar.gz into the archive directory and deletes the live session in one step.
There is no grace period and no visible intermediate state — a mistyped or
regretted archive is only recoverable by finding the tarball and importing it.

Instead, archiving should **stage**: the session moves into a folder that stays
visible in the session list, and an internal schedule performs the real archive
once it has sat there, untouched, past a retention window. Until then the user
can rescue it by moving it out.

**Most of this already exists.** `spec-soft-archive-folder` shipped the
`auto-archive` folder, the entry/exit anchor stamp, the periodic reaper, and the
export-and-remove it calls. That spec explicitly contemplated manual parking:
"The user (or the agent) can drop any session there manually to schedule it."
What is missing is the front door — the command still hard-archives — plus a
retention window suited to human second thoughts rather than herd cleanup, and
a fix for a condition that would keep a staged session from ever reaping.

This spec is therefore a **rewire and retune of one existing mechanism, not a
second one**. A parallel staging folder with its own timer would be two code
paths for one job, and the reaper's correctness work (maintenance claim,
re-check under the claim, refusal to archive live sessions) would have to be
duplicated or diverge.

Non-goals: nested folders, per-session retention overrides, a bulk staging UI,
and changing what the hard archive itself does.

## Design

**The staging folder is the existing one.** `AUTO_ARCHIVE_FOLDER` remains a
single-level session folder, already rendered as a virtual folder in the session
list, already validated by `folder.ts`, and already watched by the reaper.
Renaming it is deliberately out of scope: the name is persisted in
`SessionMeta.folder` on every currently parked session, so a rename needs a
migration that buys nothing behaviourally.

A note for anyone tempted to name the folder after the command: **`folder.ts`
strips any character outside `[a-zA-Z0-9 _/-]`**, so `caco.session-archive`
normalizes to `cacosession-archive` and `isValidFolder` still returns true. A
dotted name is silently mangled rather than rejected. This constrains naming
only; it carries no architectural weight.

**The command stages instead of archiving.** `caco.session-archive` in
`public/ts/command-registry.ts` currently resolves a display name and calls
`archiveSession()`, which issues the DELETE. It instead PATCHes the session's
folder to the staging folder, exactly as `caco.session-folder` does. The
existing PATCH handler already stamps `autoArchiveTaggedAt` on entry and clears
it on exit, so the schedule anchor needs no new write path.

**An explicit modifier keeps immediate archival reachable.** Quietly converting
a destructive command into a deferred one strands the user who wants the session
gone now. `/caco.session-archive now` retains today's behaviour and calls
`archiveSession()` unchanged. Any other argument is rejected rather than guessed
at, so a typo cannot silently pick the wrong branch.

**Staging releases the session from the active map.** This is the load-bearing
new mechanism, and without it the feature does not work. `isAutoArchiveEligible`
refuses any session where `facts.isActive` — membership in
`SessionManager.activeSessions` — and eviction only runs when that map exceeds
`MAX_ACTIVE_SESSIONS`. A user with fewer loaded sessions than the cap evicts
nothing, so a session staged from the UI (which is by definition the active one)
stays loaded, stays ineligible, and **never reaps**. The failure is silent and
looks exactly like success: the session moves into the folder, and the archive
simply never happens.

Staging therefore explicitly releases the session through the existing
`SessionManager.stop()` path, the same one eviction uses. Releasing is chosen
over relaxing the reaper's `isActive` guard because that guard is what keeps a
loaded session from being archived out from under a caller; quiescence and
loadedness answer different questions and should not be conflated. Release is
also idempotent and already exercised by eviction.

The release is exposed as an endpoint rather than driven from the client, so the
"park and release" pair happens server-side and cannot half-apply if the browser
navigates mid-sequence.

**Releasing a session is only safe under stated conditions**, and the endpoint
enforces them rather than assuming them. Staging is **refused** when a dispatch
is in flight, mirroring the existing refusal to archive a busy session and the
PATCH route's refusal to change a folder while the reaper holds the maintenance
claim; the caller gets a conflict and the session is untouched, with neither the
folder nor the anchor written. Refusing beats waiting: the user asked to put a
session away, and a mid-turn release would strand a reply nobody sees.

Staging is *not* refused merely because another client is viewing the session.
Releasing a viewed session is exactly what eviction already does when the active
cap is exceeded, and every client already handles a session that is resumed on
demand — the next interaction reloads it. What must not happen is a release
racing a dispatch, which the busy refusal covers, and a release racing the
reaper, which the maintenance claim already covers. The distinction is that a
viewer is a reader and a dispatch is a writer.

**A failed release is reported, not rolled back.** If the release throws after
the park is written, the session is parked but still loaded — the stuck state
this feature is built to avoid. Staging still reports success, with the release
flagged as incomplete, because the park is durable and is what the caller asked
for: undoing it to produce a clean failure would discard the half of the
operation that worked. The condition is self-limiting rather than permanent —
the active map is in-memory, so a restart clears it — and the sweep announces it
meanwhile. The caller is told, so a countdown that has not started is never
presented as one that has.

**The busy refusal is a UX guard, not a correctness guard.** A dispatch can
begin between the check and the release, so the check cannot be relied on for
safety. Correctness comes from downstream: the reaper re-checks eligibility
under its maintenance claim, so a session that goes live is skipped rather than
archived mid-turn. The check exists so the common case — staging something
obviously mid-reply — fails fast and legibly instead of releasing a session
about to produce output. Anyone reading it as stronger than that will build on
a guarantee it does not provide.

**Ordering within the endpoint** is park-then-release, because the reverse
leaves a window in which the session is released but not yet parked, which is
indistinguishable from an ordinary eviction and loses the user's intent if the
process dies between the two. The client's active session is read *after*
staging rather than before: if the user navigated away while it ran, they should
not be pulled into a new chat.

**The retention window is the existing one, lengthened.**
`AUTO_ARCHIVE_IDLE_MS` (overridable by `CACO_AUTO_ARCHIVE_IDLE_MS`) becomes
three days.

**One window governs both entry paths, and that is a policy choice, not an
implementation convenience.** Manual staging and herd disown share the folder,
so they share the window. Adopting it means accepting that disowned herd
children now linger about three times as long before draining — the original
soft-archive spec framed its window as a deliberate day-long observation period
for exactly those leftovers, and this supersedes that number. The judgement is
that both paths want the same thing (a grace period long enough to change your
mind, short enough that the list drains) and that a human's second thoughts are
the slower of the two, so the human window governs. If the two ever need to
diverge — say, leftovers become numerous enough that three days of clutter
hurts — the change is to record the intended window at park time alongside the
anchor, and that is a redesign of this decision rather than a tuning of it.

**The clock stays a quiescence anchor, not time-in-folder.** `archiveAnchorMs`
takes the most recent of the park stamp, last use, last idle, and creation, so
working in a staged session pushes its deadline out.

This is a deliberate deviation from a literal reading of "in the folder for
three days", and it is user-visible, so it is a stated contract rather than an
implementation detail: **the window measures time since you last touched the
session, not time since you staged it.** Stage a session and leave it alone, and
it archives on schedule. Stage it, then send it a message two days later, and
the window restarts from that message. Move it out and back in, and the window
restarts from the move. The two rules differ only when the user is actively
using something they staged, and in that case not archiving is the right answer;
a session you are still working in should not vanish because of a decision you
made three days ago. The explicit cancel is still the folder move, which is
immediate and unambiguous. The UI must describe the countdown in these terms so
"over three days" is never read as broken when recent activity extends it.

**The user is told what happened and how to undo it.** Staging reports that the
session was staged, when it will be archived, and that moving it out cancels.
The session list shows the remaining window for each staged session, so a folder
of pending archives is legible without opening each one.

**Navigation.** Staging the active session leaves the user inside a session
they have just declared finished with, and the release drops its live handle.
Staging therefore navigates away exactly as the immediate archive does today
when `wasActive` is set.

**A stuck staged session must announce itself.** The release at stage time is
one path, and one path is not enforcement — an agent or a future caller can park
a session through the PATCH route without releasing it, and a session that
returns to the active map after staging is loaded again by definition. So the
sweep also reports the condition it cannot fix: when a staged session is past
its window but ineligible, the reaper logs it once per session with the reason,
rather than skipping it silently as it does today. Overdue-but-ineligible is
exactly the signature of this feature failing, and it currently produces no
output at all. Reporting is deliberately not archiving: the guards exist for
good reasons, and the fix for a stuck session is to make it quiescent, not to
override the check.

Ownership: `command-registry.ts` owns the front door and the `now` modifier; the
sessions route owns the park-and-release pair and the busy refusal;
`session-archive-reaper.ts` continues to own eligibility and the sweep, and
gains only the overdue report; `config.ts` owns the window.

## Invariants

- A staged session is never archived while busy, resuming, a herd parent, or a
  herd child. Unchanged from the existing reaper.
- Moving a session out of the staging folder clears its anchor, so re-entry
  starts a full window rather than resuming a partial one.
- Staging never destroys data: until the reaper fires the session is intact, and
  afterwards it is recoverable by importing the exported archive.
- `/caco.session-archive` with no argument never hard-archives.
- Staging is refused outright while a dispatch is in flight; a refused stage
  writes neither the folder nor the anchor. This is best-effort: the refusal
  narrows a window rather than closing it, and the reaper's re-check under its
  claim is what actually prevents archiving a live session.
- A staged session that is past its window but ineligible is reported, not
  silently skipped. Being permanently stuck is permitted only if it is visible.
- A stage that parks but fails to release still reports success, with the
  incomplete release flagged. The park is never rolled back.
- The overdue report remembers a session only while it remains staged, so the
  bookkeeping cannot grow for the life of the process.
- The reaper's existing serialization is untouched: eligibility is re-checked
  under the maintenance claim, so a session that goes live between scan and
  archive is skipped.

## Considerations

The staging folder is shared with herd disown, so lengthening the window also
lengthens how long disowned children linger. That is clutter rather than
incorrectness, and Design records it as an accepted policy rather than a
side effect.

A session staged while another client is viewing it will be released from under
that client. This is what eviction already does, and the client already handles
a session resumed on demand. Staging while a dispatch is in flight is refused
instead, since that is a writer rather than a reader.

Staging the only session leaves the list empty; the existing new-session path
covers it.

The reaper sweeps on an interval, so a session becomes eligible before it is
archived. The displayed countdown should describe when it becomes eligible, not
promise an exact archival instant.

Agents can stage sessions too, through the same PATCH the herd already uses. No
new tool surface is needed.

If `CACO_AUTO_ARCHIVE` is disabled, staging still moves the session but nothing
ever reaps it. The command should not claim a deadline it cannot honour.

## Risks and Mitigations

**A destructive command silently changes meaning.** Someone who types
`/caco.session-archive` expecting the session to disappear now gets a delay.
Mitigated by the toast stating the staged state and the deadline, and by `now`
remaining available.

**The release step is forgotten or regressed, and nothing ever archives.** This
is the silent-success failure described above, and it is invisible in normal use
because the visible half — the folder move — still works. Mitigated by an oracle
that stages an active session and asserts it becomes eligible, and by a mutation
that removes the release and must turn that oracle red.

**A longer window hides leftovers for longer.** Accepted; the folder is visible
and the countdown is shown.

**The window is shared, so a future need for two windows is a redesign.**
Accepted deliberately; recorded here so the next reader knows it was a choice.

## Acceptance

The central oracle is 3. Items phrased as "stage it and later it archives" are
satisfiable by an implementation that only ever reaps *inactive* sessions, which
is precisely the bug — so the session must be **active at stage time** and the
assertion must be about the transition, not the eventual state.

1. `/caco.session-archive` with no argument moves the active session into the
   staging folder, stamps the anchor, and does not delete it. The session is
   still listed, now under the folder.
2. Staging a session that is in the active map leaves `isActive` false
   immediately afterwards, asserted directly rather than inferred from a later
   archive.
3. **A session that is active at stage time, staged through the real command
   path, becomes eligible once the clock passes the window and is archived by a
   sweep.** The fixture must place the session in the active map *before*
   staging and must not evict it by any other means — no cap pressure, no manual
   stop — so the only thing that can make it eligible is the release under test.
   Removing the release must turn this red; if it stays green the oracle is
   vacuous and must be rewritten.
4. Staging is refused with a conflict while a dispatch is in flight, and after
   the refusal the session's folder and anchor are both unchanged.
5. `/caco.session-archive now` archives immediately, as today.
6. `/caco.session-archive <anything else>` is refused with a usage message and
   changes nothing.
7. Moving a staged session out of the folder clears the anchor; it is no longer
   eligible, and re-staging starts a fresh window.
8. Activity in a staged session pushes its deadline out: a session staged, then
   used after most of the window has elapsed, is not eligible at the moment the
   original deadline passes.
9. A staged session that is busy, resuming, a herd parent, or a herd child is
   not archived, regardless of age.
10. A staged session past its window but ineligible is reported by the sweep,
    with the disqualifying reason, exactly once per session per condition.
11. The retention window is read from configuration, and overriding the
    environment variable changes eligibility with no code change.
12. A stage whose release throws still parks the session, reports the release as
    incomplete, and does not roll back the park.
13. A session that leaves the staging folder is forgotten by the overdue report,
    so a later stage of the same id is reported again rather than suppressed.
14. Every oracle above is mutation-tested. At minimum these mutations must each
    turn something red: removing the release at stage time; dropping the anchor
    stamp; dropping the `now` branch; accepting an unknown argument; removing
    the busy refusal; removing the overdue report; reverting the anchor to
    literal time-in-folder; letting a failed release throw; always claiming the
    release succeeded; rolling back the park on a failed release; and never
    pruning the overdue report.

## Plan

1. Add the park-and-release endpoint on the sessions route: refuse while busy,
   then set the folder, stamp the anchor through the existing PATCH logic, and
   release via the existing stop path. Return enough for the client to report
   the deadline.
2. Rewire `caco.session-archive` to call it, parse the `now` modifier, reject
   anything else, and navigate away when the staged session was active.
3. Raise the retention window default in `config.ts`.
4. Add the overdue-but-ineligible report to the sweep, once per session per
   condition.
5. Surface the remaining window per staged session in the session list,
   described as time since last touched rather than time since staged.
6. Suppress the deadline claim in the toast when auto-archive is disabled.
7. Write the oracles in the Acceptance order; each must fail before its change
   exists. Write 3 first and confirm it is red for the right reason.
8. Mutation-test every oracle against the list in Acceptance 12, especially the
   release step, whose absence is invisible in normal use.
9. Update `spec-soft-archive-folder` to point here for the manual staging path
   and to record that its observation window is superseded, so the two documents
   do not describe the folder or the window independently.

## Rationale

The instinct to write a new subsystem for this was wrong, and worth recording.
The visible symptom — "archive is immediate and irreversible" — sits in the
command layer, while the machinery the feature needs was already built, tested,
and hardened for a different caller. The actual work is one endpoint, one
rewire, one constant, and one genuine bug that only shows up because the new
entry point stages the *active* session where the old one staged an idle child.

That bug is the reason this is worth speccing at all rather than just editing
the command: the reaper's `isActive` guard was correct for herd leftovers, which
are idle by construction, and becomes a silent trap the moment a human stages
the session they are sitting in.
