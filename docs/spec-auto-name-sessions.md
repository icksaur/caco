# spec-auto-name-sessions

## Goals

A session with no user-set name displays as **"No summary"** in the
session list until the SDK's own workspace summary lands (if it ever
does — see below). That title is unhelpful, especially when the user
has several unnamed sessions from a busy day and cannot tell them
apart at a glance. First-party user feedback: this hurts.

Fill the vacancy from what the SDK already tells us. The SDK emits an
**`assistant.intent`** event whenever the model reports what it is
doing next, and Caco already captures every intent to
`meta.currentIntent` + `meta.intentHistory` (the italicised text under
each session row uses it). When the SDK's workspace summary is absent,
use the **first valid intent the session ever recorded** as the
display title instead of `"No summary"`.

This is a display fallback with a small persisted assist. It changes
no SDK behaviour, does not rename the session, and does not touch
`meta.name`. Users who explicitly name a session still see that name.
Users who never name a session and never get a workspace summary see
the intent — a phrase the model itself chose to describe the task,
which is almost always more helpful than the string `"No summary"`.

Non-goals: making the fallback authoritative (we never write to
`meta.name` and never claim the fallback IS the session's name);
calling an LLM to summarise (cost + latency + a third source of
truth); backfilling old sessions that never recorded an intent
(nothing to work with); a `caco.session-rename-auto` command (the UI
already lets the user set a name manually); auto-naming forked
child sessions (the fork path assigns an explicit `[fork]` name; that
overrides the fallback trivially — no interaction).

## Design

**The stability problem.** `meta.intentHistory` is bounded at 5
entries (`INTENT_HISTORY_LIMIT` in `session-meta-store.ts:113`) and
evicts from the front via `history.splice(0, ...)` when full. Both
`assistant.intent` events and `report_intent` tool-call arguments feed
it (`dispatch-events.ts:82-94`), so a chatty model can consume the
bound quickly. `intentHistory[0]` is therefore **NOT** the
lifetime-first intent — it is whichever intent has not yet been
evicted. A design that read `intentHistory[0]` as the title source
would produce a title that quietly rotates every few turns of a busy
session, exactly the "shimmer" this feature exists to prevent.

**The fix: a write-once auto-name latch.** Add
`meta.autoName?: string`. Stamped **at most once** per session by
`setSessionIntent`, on the first call whose intent is valid (see
validity below). Never mutated after that first stamp, never cleared
by any code path in this feature.

Once stamped, the value is stable for the lifetime of the session and
survives every mechanism that touches meta: rotation, restart from
disk, archive-export-then-import, the reaper, `caco_herd acquire`,
the folder PATCH route. None of those write `autoName`, so the value
persists trivially. This includes the case where every entry in
`intentHistory` is later evicted — the latch is not derived from the
history at read time, it was captured at write time.

**Validity predicate.** A string counts as valid for stamping and
projection iff `typeof x === 'string' && x.trim().length > 0`. The
trim guard is necessary because both event pathways accept any string
downstream — `assistant.intent` events can carry `''` from a model
that emitted an empty intent, and `report_intent` accepts any string
argument that happens to be typed as `string`. A whitespace-only or
empty string is not a title.

The same predicate applies to `workspace.summary`: an SDK-emitted
empty-string summary must not block the intent fallback. Today
`readSessionWorkspace` returns `''` when the file exists but has no
`summary:` key filled in, and the UI's `session.name ||
session.summary` chain treats that as falsy. Server-side we must be
just as strict: use `hasValidText(workspace.summary)`, not `!== null`.

**Fallback ladder.** The display title is, in order:

1. `meta.name` — the user's explicit rename.
2. `workspace.summary` — the SDK's workspace summary, iff valid.
3. `meta.autoName` — the persisted first valid intent, iff present.
4. `"No summary"` — last-resort literal, in the UI.

Levels 1, 2, and 4 are unchanged from today. Level 3 is new.

`session.currentIntent` (the most recent intent) is **not** used as a
title source. It is what the italicised sub-line already shows. A
title tied to the current intent turns the row into a duplicate of
its own sub-line and shifts every time the model reports a new step.

**Provenance carried on the wire.** The UI needs to know whether the
title it is about to render came from `meta.autoName` in order to
apply the narrow sub-line suppression rule below. Deriving that from
string equality (does `session.summary` happen to equal
`session.currentIntent`?) is unsound — a genuine workspace summary
could coincidentally match the current intent, and truncation makes a
long autoName differ from its untruncated current-intent counterpart.

Add a new field to `SessionListItem`:

```ts
titleSource: 'name' | 'workspace-summary' | 'auto-name' | 'none';
```

`SessionListItem.summary` continues to reflect the SDK's workspace
summary **and only that**. It is projected null when the workspace
summary is absent or invalid. Downstream consumers that read `summary`
(`session-panel.ts:626` drag payload, `session-panel.ts:665` fallback
render, `main.ts:145` pound provider) keep working unchanged because
the ladder they implement (`name || summary || fallback`) already
prefers `name`, and their existing `summary || 'No summary'` line
picks up `null` today.

A new field `autoName` is also projected onto `SessionListItem`, so
the UI has the title candidate without having to reverse-engineer it
from `intentHistory`. Its lifecycle mirrors `meta.autoName`: null when
unset, otherwise the persisted first-valid-intent value, unchanged for
the life of the session.

The title-render step at `session-panel.ts:665` becomes: prefer
`session.name`, then `session.summary`, then `session.autoName`, then
`'No summary'`. `titleSource` tracks which one won, so the sub-line
suppression rule can key off it.

**Sub-line suppression is scoped to the auto-name case only.** When
`titleSource === 'auto-name'` AND `session.currentIntent` equals
`session.autoName` (raw, pre-truncation equality — see below), the
italicised sub-line is suppressed to avoid rendering the same string
twice on one row. For every other `titleSource`, the sub-line renders
as before whether or not `currentIntent` happens to match, because a
`meta.name` session's italics carry orthogonal status information the
user chose to see.

**Truncation is display-only.** `meta.autoName` is stored untruncated.
The UI truncates at 60 characters when rendering the title, matching
the existing `session-panel.ts` layout constraints. The 60-char limit
does NOT apply to the sub-line, which already lives in a wider row
below the title. Provenance-flag lookup (`titleSource === 'auto-name'
&& currentIntent === autoName`) is against the untruncated wire
values, so truncation cannot desync the suppression rule from
equality.

The drag payload at `session-panel.ts:626` picks up the truncated
title exactly as displayed — a drag receiver reading a paragraph is
still unpleasant. The truncation logic lives in one helper the title
render and the drag payload both use, so the two surfaces cannot
drift.

**Fresh workspace summary read in `list()`.** Today the session list's
`summary` field is destructured from `sessionCache[id]`, which is
populated at discovery time (`session-manager.ts:914-919`) and never
refreshed on the ordinary path. A workspace summary that lands after
discovery (SDK writes to `workspace.yaml` after the user's first
prompt completes) does not appear in subsequent `list()` calls until
a restart or an explicit import. This is a pre-existing bug and is
what would silently keep the autoName visible after the SDK
eventually produces a real summary.

`list()` already calls `readSessionWorkspace(sessionId)` on every
iteration — for `updatedAt`. Change: use the same call's `summary`
field instead of the cached one. Cost is unchanged (one read either
way). The cache entry's `summary` becomes an unused legacy field; a
follow-up cleanup can remove it, but this spec does not touch the
cache shape (blast radius).

**When does `autoName` get stamped, exactly?** Inside
`setSessionIntent`, in the same `updateSessionMeta` callback that
already writes `currentIntent` and pushes to `intentHistory`. The
callback checks:

```
if (!meta.autoName && hasValidText(intent)) meta.autoName = intent;
```

The `!meta.autoName` guard is the write-once mechanism. On a session
that already has `autoName` set (any prior valid intent), later
intents update `currentIntent` and `intentHistory` as before but do
nothing to `autoName`. The stamp happens on the first valid intent
ever seen for the session.

A session whose first `report_intent` argument is empty or
whitespace-only does not stamp; the first later valid intent stamps
it. This is the safe direction — an unhelpful string is worse than
"No summary" because it looks intentional. Skipping invalid values
means a session with only ever-invalid intents stays at "No summary",
which is the current behaviour.

**Interaction with the existing intent-history bound.** Nothing
changes about the bound. `intentHistory` still holds the 5 most
recent entries, still evicts from the front, still drives the
italicised sub-line via `session.currentIntent`. The auto-name latch
is a separate persisted value that captures the first valid intent
independently, so eviction of the history cannot lose the latched
value.

**Archive round-trip.** The archive export writes the full
`~/.caco/sessions/<id>/` tree into the tarball, which includes
`meta.json`. Import restores the whole tree. `meta.autoName` rides
along with no code change to the archive path. The reaper never
writes meta beyond `folder`/`autoArchiveTaggedAt`. So a stamped
session survives archive/restore, and an unstamped one comes back
still unstamped — the next valid intent after restore stamps it.

**Fork does not inherit.** `POST /api/sessions/:id/fork` at
`routes/sessions.ts:540-584` writes a fresh `meta.json` with an
explicit `name = '<parent-name> [fork]'`. The `autoName` field is
not carried over. The child's `titleSource` will be `'name'`, so the
fallback is moot for a fork.

Ownership:
- `src/session-meta-store.ts`: add `SessionMeta.autoName?: string`;
  modify `setSessionIntent` to latch it on the first valid intent.
- `src/session-manager.ts`: `list()` reads `workspace.summary` from
  the fresh workspace call; adds `autoName` and `titleSource` to
  `SessionListItem`.
- `public/ts/types.ts` (or wherever `SessionData` lives): add
  `autoName?: string | null` and `titleSource: 'name' |
  'workspace-summary' | 'auto-name' | 'none'`.
- `public/ts/session-panel.ts`: title render prefers
  `name || summary || autoName || 'No summary'`; sub-line
  suppression keyed on `titleSource === 'auto-name'` AND
  `currentIntent === autoName`. Extract a `truncateForTitle` helper
  shared by the title render and the drag payload.

## Invariants

- **Nothing about `meta.name` changes.** The auto-name latch is
  strictly separate.
- **`meta.autoName` is write-once.** The first `setSessionIntent`
  call whose argument passes `hasValidText` writes it. No later
  call overwrites, clears, or reads-then-rewrites it.
- **Empty/whitespace intents never stamp.** A session with only
  empty intents ever recorded has `meta.autoName === undefined` and
  displays `"No summary"`, matching current behaviour.
- **`autoName` survives every meta-writing path** in this codebase
  because no other path touches the field: rotation, reaper, folder
  PATCH, herd acquire/disown, archive import, stage-for-archive.
  None of them read or write `autoName`.
- **`autoName` survives `intentHistory` eviction.** The latch is
  captured at intent-write time; the bounded history has no bearing
  on the latch's value.
- **`workspace.summary` is validated against the same predicate**
  as `autoName`: trimmed non-empty. An empty-string workspace summary
  does not block the auto-name fallback.
- **`SessionListItem.summary` remains the SDK's workspace summary,
  validated.** The auto-name is projected under `autoName`, not
  overloaded onto `summary`.
- **`titleSource` reflects which ladder level won.** If
  `name` is valid, `titleSource === 'name'`; else if
  `workspace.summary` is valid, `'workspace-summary'`; else if
  `autoName` is valid, `'auto-name'`; else `'none'`.
- **Sub-line suppression is scoped to auto-name-titled rows.** Only
  `titleSource === 'auto-name'` AND `currentIntent === autoName`
  suppresses. Every other combination renders the italicised sub-line
  as before.
- **Truncation is display-only.** Wire-side `autoName` is the full
  string; the 60-char truncation happens in the UI title render and
  in the drag-payload builder via one shared helper.
- **`list()` reads `workspace.summary` fresh, not from
  `sessionCache`.** A workspace summary that lands after discovery
  appears in the next `list()` call.

## Considerations

- **The first intent is model output, not user intent.** The model
  reports what IT thinks it's doing, usually derived from the user's
  first prompt. When the model gets it right, this is helpful; when
  it summarises badly, the title is a paraphrase the user didn't
  write. This is acceptable because the current title is literally
  `"No summary"`, which conveys zero information, and the user can
  rename any time. A bad auto-name is a strict improvement over
  `"No summary"` even when mildly wrong.
- **`assistant.intent` is not always emitted.** The model calls
  `report_intent` when it deems the task substantial enough. A
  one-question chat may never trigger either pathway, so its title
  stays at `"No summary"`. This is the "unreliable but harmless"
  case — the feature can't help every session, but it doesn't hurt
  any.
- **`autoName` predates this spec for no session.** The field is new;
  every existing session has it absent. On upgrade, `autoName` is
  stamped on the first NEW valid intent each existing session
  records — for sessions the user is still using, this happens
  quickly; for archived sessions that never resume, the field stays
  absent and the display stays as it is today. No backfill needed.
- **The stamp is idempotent under re-processing the same event.**
  If the SDK somehow replays an old `assistant.intent`, the
  `!meta.autoName` guard drops the second write. This is the safe
  direction — the latched value is the one the user has been seeing.
- **A future SDK version replaces the workspace summary mechanism.**
  If the SDK stops emitting `workspace.summary` entirely, `autoName`
  carries the load. If the SDK changes the intent event names, this
  feature silently degrades to today's behaviour (`"No summary"`
  for sessions without a workspace summary), which is
  strictly-safe.
- **Sub-line suppression is deliberately narrow.** Only when the
  title came from `autoName` AND currently matches the intent —
  the only case where a visual duplicate actually occurs. A
  user-named session with a current intent shows both; a
  workspace-summary session with a matching current intent shows
  both (very rare, but the workspace summary is the SDK's
  intentional signal, not our fallback).
- **Truncation width.** Sixty characters is picked because it's
  roughly what fits in the sidebar at default width without eating
  into the age/action buttons. If the sidebar layout ever changes,
  the constant moves with it (one place: the shared helper).

## Risks and Mitigations

- **First intent is misleading** (the model announced a sub-task
  that isn't the session's real subject). Mitigation: the user
  renames — one action, existing UI. There is no new setting to
  disable auto-naming because the manual rename already covers
  every case.
- **A very long intent still starves the row.** Mitigated by the
  60-char UI truncation; a runaway intent produces
  `"first sixty chars of the intent…"`, not a whole paragraph.
- **Downstream `summary` consumers.** Enumerated:
  `session-panel.ts:626` (drag payload), `session-panel.ts:665`
  (title render), `main.ts:145` (pound-provider label). All three
  read `s.summary` truthy-checked with `||` chaining before or
  after `name`. Keeping `summary` truthful to the SDK's workspace
  summary means none of these break; the two title-related
  consumers gain `autoName` in their `||` chain, the pound provider
  can stay as-is (an unnamed unfilled-summary session already
  displays as its id prefix in that context, which is fine).
- **Intent contains PII or something embarrassing.** The intent is
  model output already stored to disk in `meta.intentHistory` and
  already visible in the italicised sub-line today. Latching one
  intent value to `autoName` exposes nothing that isn't already
  exposed.
- **Cache staleness on `summary`.** Reading fresh from the same
  `readSessionWorkspace` call already made in `list()` moves the
  fix out of the cache-invalidation area entirely. If a future
  refactor caches `readSessionWorkspace` results, the cache would
  need its own freshness signal, but that is out of scope.
- **`meta.name` was empty-string, not undefined.** Today `meta.name
  || ''` treats both the same. The fallback ladder must use the
  same truthiness check (trimmed non-empty) so a session with
  `meta.name === ''` — a real state, set by
  `session-meta-store.ts:139` when creating a fresh meta — falls
  through to the workspace-summary and auto-name levels rather
  than displaying nothing.
- **Fork inherits `autoName`.** Explicitly no: `POST /fork` writes
  a fresh meta with an explicit name and does not read the parent's
  `autoName`. Documented above.

## Acceptance

Ten load-bearing oracles. Each must turn red if the corresponding
behaviour is removed. Green tests that survive removal are vacuous
and must be rewritten.

1. **`hasValidText` predicate.** Table:
   - `''`, `'   '`, `'\t\n'`, `undefined`, `null`, `42`, `{}` return
     `false`.
   - `'hello'`, `'  hello  '` return `true`.

2. **First valid intent stamps `meta.autoName`.** `setSessionIntent`
   on a session with no prior autoName, called with a valid intent,
   writes `meta.autoName === '<intent>'`.

3. **Write-once: later intents do NOT overwrite.** A second
   `setSessionIntent` call with a different valid intent leaves
   `meta.autoName` at the first value. `currentIntent` and
   `intentHistory` reflect the second call as usual.

4. **Empty/whitespace intents do NOT stamp.** `setSessionIntent`
   called with `''` or `'   '` leaves `meta.autoName === undefined`.
   A subsequent valid intent then stamps to that valid value (skip
   the invalid, latch the first-valid).

5. **Latch survives `intentHistory` eviction — the principal
   correctness oracle.** Push 6 distinct valid intents to a session
   through `setSessionIntent`; assert `meta.autoName` still equals
   the FIRST intent even though `intentHistory[0]` is now the
   second (the first was evicted by the 5-entry bound). A mutation
   that reads `intentHistory[0]` in `list()` instead of
   `meta.autoName` must turn this red.

6. **`list()` projection ladder.** Four fixture rows, one per
   `titleSource` outcome:
   - `meta.name = 'my chat'` → `titleSource === 'name'`, `summary`
     and `autoName` on the wire still carry their raw values.
   - `meta.name = ''`, workspace summary `'work'` → `titleSource
     === 'workspace-summary'`, `summary === 'work'`.
   - `meta.name = ''`, workspace summary `''`, `meta.autoName =
     'first thing'` → `titleSource === 'auto-name'`, `summary ===
     null` (empty workspace summary falls through), `autoName ===
     'first thing'`.
   - None of the three → `titleSource === 'none'`, `summary ===
     null`, `autoName === null`.

7. **`list()` reads `workspace.summary` fresh.** Fixture: cached
   `sessionCache[id].summary === null`, but `readSessionWorkspace`
   now returns a valid summary. Next `list()` call projects the
   workspace summary. A mutation that reads from the cache must
   turn this red.

8. **UI title render + truncation.** Given a `SessionData` fixture:
   - `name = ''`, `summary = null`, `autoName = 'first intent'`,
     `currentIntent = 'now doing X'` → title renders `'first
     intent'`, sub-line renders `'now doing X'`.
   - `autoName` of 100 chars → title displays `<first 60 chars>…`;
     drag payload uses the same truncated value (both go through
     one `truncateForTitle` helper).

9. **Sub-line suppression scoped to auto-name.** Two rows:
   - `titleSource === 'auto-name'`, `currentIntent === autoName`
     (untruncated) → sub-line SUPPRESSED.
   - `titleSource === 'name'`, `currentIntent === name` (a
     user-named session whose italics coincidentally match) →
     sub-line RENDERS. Real status information is not lost to
     coincidence.

10. **Archive round-trip preserves `autoName`.** Stamp `autoName` on
    a fixture session, export via the archive path, remove the
    live session, import from the tarball. `meta.autoName` is
    preserved byte-for-byte. Guards against a regression where
    export/import strips unknown fields.

## Mutations

At minimum these mutations must each turn one of the oracles above
red:

- Drop the `!meta.autoName` guard in `setSessionIntent` (2 stays
  green; 3 turns red).
- Drop the `hasValidText` guard on stamp (4 turns red).
- Read `intentHistory[0]` in `list()` instead of `meta.autoName` (5
  turns red).
- Read `sessionCache[id].summary` instead of the fresh workspace
  read (7 turns red).
- Drop the 60-char truncation from the shared helper (8 turns red).
- Drop the sub-line suppression rule (9's first row turns red — the
  visual duplicate appears).
- Broaden the sub-line suppression to fire on `titleSource ===
  'name'` (9's second row turns red).
- Overload `SessionListItem.summary` with `autoName` (6's
  `'auto-name'` row turns red — `summary` should be null).
- Relax the workspace-summary empty-string check to `!== null` (6's
  `'auto-name'` row turns red — empty workspace summary would win
  and block autoName).
- Archive export dropping the `autoName` field (10 turns red).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `SessionMeta.autoName?: string` field | `src/session-meta-store.ts` | field exists; unchanged sessions do not carry it | write-once; scoped |
| 2 | Extract `hasValidText(x): boolean` — a shared predicate | `src/session-meta-store.ts` (or a new `src/text-predicates.ts` if reused elsewhere) | Acceptance 1, 2 | predicate |
| 3 | In `setSessionIntent`, stamp `meta.autoName = intent` iff `!meta.autoName && hasValidText(intent)`, in the same updater that already writes `currentIntent` and `intentHistory` | `src/session-meta-store.ts` | Acceptance 3, 4, 5, 6, 7 | write-once; empty-not-stamped; latch-survives-eviction |
| 4 | Add `autoName?: string \| null` and `titleSource: 'name' \| 'workspace-summary' \| 'auto-name' \| 'none'` to `SessionListItem` | `src/session-manager.ts` (interface + list()); `public/ts/types.ts` (or wherever `SessionData` lives) | Acceptance 8-13 | provenance-on-wire |
| 5 | `list()` computes `summary` from the fresh `readSessionWorkspace().summary` (already called for `updatedAt`), validated via `hasValidText`; computes `titleSource` per the ladder | `src/session-manager.ts` | Acceptance 10, 11, 13 | fresh-workspace-read; workspace-empty-string-falls-through |
| 6 | Extract `truncateForTitle(text, maxChars = 60): string` helper | `public/ts/session-panel-helpers.ts` (new small module) or inline in `session-panel.ts` | Acceptance 19 | truncation-shared |
| 7 | Title render uses the ladder (`name \|\| summary \|\| autoName \|\| 'No summary'`) with truncation applied to `autoName` and the drag payload | `public/ts/session-panel.ts` | Acceptance 14-20 | ladder; truncation |
| 8 | Sub-line suppression: keyed on `titleSource === 'auto-name' && currentIntent === autoName` (untruncated equality) | `public/ts/session-panel.ts` | Acceptance 17, 18 | sub-line-suppression-narrow |
| 9 | Archive round-trip test: stamp autoName, export, wipe, import, assert preserved | `tests/unit/archive-*.test.ts` (extend an existing archive test) | Acceptance 10 | latch-survives-archive |
| 10 | Mutation-test every oracle against the list in the Mutations section | tests | all | all |

## Rationale

Sol-Fast's review found the load-bearing problem: `intentHistory[0]`
is not the lifetime-first intent because the 5-entry bound evicts
from the front. Reading it as the title source produced a title that
would shimmer over the life of a chatty session — exactly what a
title should not do. The fix is a persisted write-once latch that
captures the first valid intent at stamp time, independent of the
rolling history's eviction behaviour.

That is more state than the original spec wanted to introduce, but
the cost is small (one optional string field) and the benefit is a
genuinely stable title source rather than one that pretends to be
stable. The alternatives — remove the history bound, or read the
history-write path from a different angle — cost more or drift the
existing intent-storage semantics.

The wire-shape change (adding `titleSource` and `autoName` to
`SessionListItem`) was likewise driven by the review: overloading
`summary` prevents the UI from telling why the string it's about to
render came to be there, which the sub-line suppression rule needs
in order to be scoped correctly. Providing provenance explicitly on
the wire is cheaper than reconstructing it via string equality —
which would fail under truncation, coincidental matches, and future
changes to the intent/summary text sources.

The fresh `workspace.summary` read in `list()` is a small preexisting
bug that this feature would silently mask if not fixed: without it,
an autoName would persist as the visible title even after the SDK
belatedly produced a real workspace summary. Reading the workspace
summary from the same call `list()` already makes closes that gap at
zero extra cost.

The validity predicate matters more than it sounds. Empty strings
from either the intent event or the workspace summary field would
otherwise silently cause the wrong ladder level to win — an empty
autoName would look "set" to the wire, an empty workspace summary
would block a valid autoName. Applying `hasValidText` consistently at
every projection point closes that gap, and the predicate is small
enough to live in one file and be reused everywhere it's needed.

The sub-line suppression rule is the one non-obvious UI decision. Its
purpose is narrow: when the same string would render twice on one
row, hide the duplicate. Scoping it to the auto-name case only —
using `titleSource` rather than inferring from string equality — is
what keeps the rule from silently swallowing information a
user-named session was communicating deliberately.
