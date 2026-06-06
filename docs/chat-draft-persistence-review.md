# review: chat-draft-persistence.md

Reviewer pass against `docs/chat-draft-persistence.md`, the existing
codebase, and the personal code-quality bar. Verdict: **spec is close
to ready**, but a few correctness gaps and one design question should
be resolved before implementation.

## BLOCKER

### B1. Send-time race only cancels the timer, not in-flight requests

Spec §Edge cases ("Concurrent send + debounce flush") and Implementation
step 5 mitigate the debounce/send race by *cancelling the pending
timer* before issuing DELETE. That covers timer→DELETE, but not the
case where a PUT has already fired and is in flight:

```
t=0   user types last char   → timer set
t=1.0 timer fires             → PUT in flight (network ~200ms)
t=1.1 user presses Send       → cancel timer (no-op, already fired)
                              → DELETE issued
t=1.15 DELETE lands           → file removed
t=1.20 PUT lands              → file recreated with sent text
t=∞   draft reappears on next reload
```

The spec must either (a) track the in-flight PUT promise in the
controller and `await` it before issuing DELETE, or (b) serialize all
draft requests through a per-key queue. Without one of these the
"clear after send" guarantee is best-effort and the bug will be
hard to reproduce.

Citation: spec line 131, lines 202–206.

### B2. PUT-to-nonexistent-session can silently create a session dir

Spec line 147–149 says PUT returns 404 if the session directory
doesn't exist. The proposed implementation in step 1 reuses the
`setSessionData` pattern (`src/session-data-store.ts:41-46`), which
calls `ensureDir(getSessionDir(sessionId))` unconditionally — it
will happily *create* `~/.caco/sessions/<bogus-id>/` and write
`chat-draft.txt` inside.

The spec needs to call this out explicitly: the new
`setSessionDraft` must `existsSync(getSessionDir(sessionId))` first
and return a "missing" signal, and the route must map that to 404.
Otherwise a stale browser tab pointing at a deleted session will
resurrect a ghost directory on every keystroke and the cleanup
guarantee in §3a (`src/session-manager.ts:811`) is defeated.

Citation: spec lines 147–149, 163–170, 182–186; code
`src/session-data-store.ts:41-46`, `src/storage-paths.ts:23-25`.

### B3. Restore conflicts with `restoreFailedPrompt`

`ChatViewController` uses the same `sessionDrafts` Map as the
recovery path for failed sends (`chat-view-controller.ts:382-393`).
When a send fails, the unsent text is written into the Map so the
next `showChat` puts it back in the textarea via `restoreDraft`
(line 281).

The spec's new restore logic (step 5) says: "if the Map entry is
empty AND the textarea is empty, GET the disk draft". That is
correct for the Map case, but consider this sequence:

1. User sends "abc" — `savePrompt` deletes the Map entry *and*
   the disk file should be deleted (step 5 send path).
2. Send fails — `restoreFailedPrompt` writes "abc" back into the
   Map only. Disk is still empty.
3. User reloads. On activation, Map is empty (cleared on reload),
   textarea empty, GET returns 404 → recovery text is **lost**.

Either the failed-prompt path also has to PUT to disk, or the spec
must document that "failed-send recovery does not survive a reload"
(currently it does survive a session switch, so this is a
regression in expectations). Pick one and write it down.

Citation: `public/ts/chat-view-controller.ts:377-394`; spec lines
97–104, 196–206.

## IMPORTANT

### I1. REST vs WebSocket bus — REST is the right call, but spec should justify

You flagged this as a focus item. The WebSocket `setState`/`getState`
handlers (`src/routes/websocket.ts:157-181`) operate over
`appletUserStates`, an **in-memory** `Map` in `src/applet-state.ts`
that does not persist across server restarts. Reusing them would
require teaching that store to write to disk, which is a larger
change than the spec proposes, *and* would entangle drafts with
the applet-state lifecycle (which uses shallow-merge and a
DEFAULT_KEY fallback that doesn't fit the per-session-file model).

REST is also robust against the WebSocket-not-yet-connected window
on page load. Conclusion: REST is correct, but the spec should
say so in one sentence under §API rather than leaving it implicit;
otherwise a future reviewer will ask the same question.

### I2. Restore-on-every-activation is fine, but state it

Spec step 5 says GET runs only when the Map entry is empty. On the
*first* page load that's every session activation; on subsequent
in-page session switches it's a Map hit, no fetch. That's correct
behavior — pre-fetching the full draft list at boot would be a
premature optimization (most users touch one session per load).

But the spec should explicitly note: "first-load GET per activated
session is acceptable; the Map serves cross-switch hits". This
prevents a future "why don't we eagerly load all drafts" patch.

Citation: spec lines 86–95, 196–200.

### I3. Body-parser claim under-specifies the change

Spec step 3 says "Wire body parsing for `text/plain` if not already
configured." It is **not** configured globally — the project does
not use a global body parser. The existing pattern (see
`src/routes/api.ts:438`) is per-route middleware:

```ts
router.put('/files/*path', express.text({ type: '*/*', limit: '10mb' }), ...)
```

The spec should say: "attach `express.text({ type: 'text/plain',
limit: '1mb' })` per-route on the three PUT endpoints; do not add
a global parser." This avoids accidentally widening the body-parse
scope and gives the 1 MiB cap a single home (the middleware itself
returns 413 on overflow — no manual check needed).

Citation: spec lines 177–180, 153–157; code
`src/routes/api.ts:77, 438`.

### I4. Hard-truncate of user input is jarring

Spec step 6 says "if `value.length > 1MiB`, truncate and show a
warning". Mutating the user's typed text out from under them is a
bad pattern — it can land mid-paste, mid-word, and the user has no
undo for it. Better: **stop persisting** at the cap (skip the PUT,
show the warning, keep the in-memory text), and let the user trim
manually. The 1 MiB threshold is so far above realistic chat input
that the warning is the actual UX, not the truncation.

If the concern is keeping the in-memory textarea bounded for
performance, that's a separate problem and the cap should be much
lower (e.g. 256 KiB) and enforced at keypress, not at the
persistence boundary.

Citation: spec lines 208–211.

### I5. Global new-chat draft across CWDs is surprising

You flagged this. Concrete failure case: user starts drafting "fix
the failing auth tests" in new-chat with cwd=repoA, navigates to a
session in repoB, opens new-chat again (still cwd=repoB now) — sees
the repoA draft sitting on top of an unrelated repo. The "stale
weeks-old draft" risk noted in spec line 231 is real but minor;
the cross-CWD bleed is more likely to bite weekly.

Two reasonable resolutions, pick one and write it in:

- **Accept it**: state explicitly under §Scope that the new-chat
  draft is global *by design*, the same way the session list is
  global, and that switching CWDs does not clear it. Cite
  `getNewChatCwd` (`public/ts/app-state.ts`) so readers know
  what's per-CWD and what isn't.
- **Key by CWD**: `~/.caco/drafts/newchat-<hash(cwd)>.txt`.
  Slightly more code; eliminates the surprise.

Either is defensible. The spec currently waves at it ("one single
buffer", line 22) without acknowledging the cross-CWD case.

### I6. File placement: `~/.caco/chat-draft-newchat.txt` clutters the root

Per `src/storage-paths.ts:14`, `STORAGE_ROOT` is `~/.caco/`. Today
the only top-level entries under it are `sessions/` (and tooling-
managed dirs). Dropping `chat-draft-newchat.txt` at the root mixes
a transient document into what is otherwise a directory of
directories. Prefer `~/.caco/drafts/newchat.txt` (or
`~/.caco/global/chat-draft.txt`) — adds one `ensureDir` call and
keeps the root tidy. Trivial change to the spec, but worth doing
now rather than migrating later.

Citation: spec lines 44–47.

## NICE-TO-HAVE

### N1. Step 3a (cleanup on session delete) is already a non-issue

You asked. `sessionManager.delete()` ultimately calls
`rmSync(cacoPath, { recursive: true })` (`src/session-manager.ts:811`).
Since the proposed draft file lives at
`~/.caco/sessions/<id>/chat-draft.txt`, it gets removed for free.
The spec can shorten §3a from "confirm and possibly add cleanup" to
a one-line "draft sits inside the session dir; existing recursive
rm covers it" with the file:line citation. Less noise in the plan.

### N2. 404 vs 204 on GET is fine as specified

You asked. 404 on missing session vs 200 on existing-with-draft is
the right shape — the client genuinely needs to distinguish "no
draft yet" from "session vanished". Collapsing to "always 204 with
empty body" would silently mask the disappeared-session case. Keep
the spec as-is.

### N3. Per-tab multi-tab clobbering — typical user won't hit it

You asked. The dominant multi-tab pattern in Caco appears to be
one tab per session (the session list is the entry point), not
multiple tabs on the same session. Last-writer-wins is acceptable.
But the *new-chat* case is more likely to multi-tab (two new chats
open in two repos) and ties back to I5. If you pick the "key by
CWD" option in I5, the multi-tab risk drops further.

### N4. `getLastInput()` up-arrow recall is out of scope but related

`chat-view-controller.ts:399-403` and
`multiline-input.ts:96-104` implement up-arrow recall using the
in-memory `sessionPrompts` Map. That Map is also cleared on
reload. Not part of this spec, but worth a sentence in §Out of
scope so a future reader doesn't assume "drafts persist therefore
up-arrow recall persists".

### N5. CR/LF note in §Risks is correct but inconsequential

Spec line 234–236. `express.text` hands the raw body through; the
file round-trips bytes verbatim; nothing to do. Could be deleted.

## Spec-quality checklist (from review-spec SKILL.md)

| Check | Result |
|---|---|
| Goal clearly defined | ✅ |
| Use cases comprehensive | ✅ (edge-case table is good) |
| UX defined per use case | ⚠ I4 (truncation UX), I5 (cross-CWD) |
| Considerations comprehensive | ⚠ B3 (failed-prompt interaction missing) |
| Code analysis accurate | ⚠ B2 (`ensureDir` behavior), I3 (body parser) |
| Risks comprehensive | ⚠ B1 (in-flight PUT race) |
| Divisible | Spec is small enough not to split |
| Self-contained for fresh agent | ✅ file:line citations are accurate and resolve |
| Avoids transient state | ✅ |
| Addresses goals | ✅ |
| Edge cases | ⚠ see B1, B3 |

## Summary

Fix B1, B2, B3 before implementation — they are real correctness
bugs the spec as written will produce. Resolve I1–I6 with a sentence
each. The nice-to-haves are polish.
