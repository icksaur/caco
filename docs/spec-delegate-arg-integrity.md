# spec-delegate-arg-integrity

## Goals

Stop a dropped tool-call argument from becoming an opaque dead end. When
`caco_session_delegate` is invoked with an incomplete `prompts` entry — in
practice, a missing `sessionId` because the trailing key was lost in argument
generation — the caller must get an actionable error naming the missing field
instead of the generic `Tool execution failed`, so it can retry correctly rather
than misattribute the failure to the target session.

Measured incident: three consecutive calls failed 13 ms after start, with
`prompts[0]` containing only `message` and no `sessionId` — while all 33
successful calls in the same session carried both keys, and no failure carried
both. The `message` values arrived complete (ending exactly where they should),
so the payload was not cut mid-value; the trailing key/value pair was simply
absent, the signature of a truncated argument stream closed by a lenient parser.
Because `sessionId` is `z.string()` (required), the SDK rejected the call during
schema validation, before the handler ran, and the reason was replaced with
`{"message":"Tool execution failed","code":"failure"}`. Corroborating evidence:
the server log holds no `[DELEGATE] Sending` line for any of the three (so the
handler never ran) and no exception; the three metadata lookups in the guard are
total functions; and a short message to the *same* inactive target succeeded
immediately afterwards, ruling out the target's state.

Non-goal: preventing the upstream truncation. Caco does not own tool-call
argument generation and cannot stop a key from being dropped. The goal is
strictly that the failure be **legible and recoverable** at the call site.

## Design

**Own the validation instead of delegating it to the schema.** `sessionId`
becomes `z.string().optional()` in the `caco_session_delegate` parameter schema,
and the handler rejects a missing/blank one with a message that names the field
and the index. This is not a weakening of the contract — it is a relocation of
the check from a layer that discards its error to one that can report it. The
`.describe()` text continues to state that `sessionId` is required, so the
documented contract the model reads is unchanged.

**This is the shape `caco_herd` already uses**, and the reason it has never shown
this failure mode: its `sessionId` is `z.string().optional()` and the handler
returns `` `${action} requires a sessionId.` `` when it is absent.
`caco_session_delegate` is the only session-targeting tool that still leaves the
identifier required at the schema layer, so it is the only one whose failure mode
is total information loss. The fix makes the two consistent, so there is one way
to express "this tool needs a session id" across the tool surface.

**The error must be self-correcting.** The returned message states which entry is
incomplete, that the arguments were delivered incomplete rather than the target
being at fault, and what to do (re-send with an explicit `sessionId`; if it
recurs, shorten the message — length raises truncation probability). Without the
last part the caller can loop on the same oversized call.

**Validation happens before any side effect.** The check runs in the same pass as
the existing target guards, before plugin directories are applied and before any
message is dispatched, so an incomplete batch never half-sends. Consistent with
the existing guard loop, the whole call is rejected rather than the bad entry
being silently dropped — a partially-delivered delegation is worse than a clean
refusal, because the caller would block waiting for a reply that was never
requested.

## Invariants

- **A missing `sessionId` is reported, never opaque.** An entry lacking a usable
  `sessionId` produces a `resultType:'error'` result naming the offending index,
  and never a schema-level rejection.
- **No side effect precedes validation.** If any entry is invalid, zero plugin
  directories are applied and zero messages are dispatched — the call is refused
  whole.
- **The documented contract is unchanged.** `sessionId` remains required in the
  tool description and in `.describe()`; only the enforcement layer moves.
- **Blank is treated as missing.** An empty, whitespace-only, or **prefix-only**
  (`caco-session:`) `sessionId` takes the same path as an absent one. Validation
  runs on the NORMALIZED id — prefix stripped, whitespace trimmed — so the
  emptiness test sees exactly the value the target guards would, and a
  prefix-only truncation artifact can never degrade into a confusing "does not
  exist" for id `""`.
- **One way to require a session id.** `caco_session_delegate` and `caco_herd`
  both enforce it in the handler with an actionable message.

## Considerations

- **Does optional-in-schema invite omission?** The model reads the description,
  which still says required, and every one of the 33 successful calls supplied it.
  The observed omissions were transport truncation, not intent. The downside of
  the strict schema (total information loss) is strictly worse than the
  hypothetical downside of the loose one (a clear, retryable error).
- **Why not repair instead of reject?** With one target and a known caller a
  missing id looks guessable, but there is no safe inference: sending a review
  request to the wrong session is a silent, expensive error. Refusing costs one
  retry; guessing can burn a whole session's context.
- **Why reject the batch rather than the entry?** The caller blocks awaiting one
  reply per prompt it believes it sent. Dropping an entry silently would make it
  wait on a delegate that was never messaged, which reads as a hang.
- **Generality.** Any tool with a long free-text field beside a short required
  identifier shares this exposure, because tool-call arguments are emitted in
  generation order rather than schema order — which is why `sessionId` was dropped
  even though it is declared first. Two tools match: `caco_session_delegate` and
  `create_caco_session` (`initialMessage` beside the required `cwd`/`model`), and
  both are fixed here. `caco_herd` was already safe. Tools whose payload is a
  single field (the workflow/SQL/eval tools) and `get_session_state` (an id with no
  long field beside it) are not exposed. The pattern to copy is: identifier
  validated in the handler, not the schema.
- **The truncation itself is upstream and unfixed.** Shortening delegate messages
  reduces but does not eliminate it. The mitigation here is legibility.

## Risks and Mitigations

- **A real caller bug is now a soft error instead of a hard one.** Mitigation: the
  message is explicit and the result is `resultType:'error'`, so it is visibly a
  failure, not a silent success; oracles assert nothing is dispatched.
- **Message text drifts from the actual check.** Mitigation: one validation site
  produces the message; oracles assert the message names the index and that no
  fetch occurred.
- **A future edit re-tightens the schema**, restoring the opaque failure.
  Mitigation: the invariant is stated here and the oracle drives the handler with
  an entry that omits `sessionId` — which is only expressible while the schema
  permits it, so re-tightening breaks the test.

## Acceptance

- Observable: invoking `caco_session_delegate` with a `prompts` entry that omits
  `sessionId` returns an error naming the entry and instructing a retry, instead
  of `Tool execution failed`; no message is sent to any target.
- Budgets: n/a (one added string check per prompt entry).
- Gates: `tsc` ×2, `lint:strict`, `knip`, `npm test` (coverage floors),
  `build:client`, `check:specs` — all green.
- Oracles:
  - **missing id is actionable** — an entry with no `sessionId` yields
    `resultType:'error'` whose text names the index and mentions re-sending; the
    message does not say "does not exist".
  - **blank id is treated as missing** — `''`, `'   '` and the prefix-only
    `'caco-session:'` all take the missing path, not the target-guard path.
  - **no side effect on refusal** — with one valid and one invalid entry, `fetch`
    is never called and `applyPluginDirectories` is never called; the whole batch
    is refused.
  - **valid batch unaffected** — a well-formed one- and two-target call behaves
    exactly as before (regression guard on the existing tests).
  - **prefix stripping still applies** — `caco-session:<uuid>` continues to
    validate and strip.
  - **create_caco_session names its missing arguments** — a call with `cwd` or
    `model` dropped returns an error naming which one(s), and creates nothing.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Make `sessionId` `z.string().optional()` in the `caco_session_delegate` schema, keeping the `.describe()` wording that it is required | `src/delegate-tool.ts` | valid-batch-unaffected | documented-contract-unchanged |
| 2 | Pure `normalizeDelegateTargetId` (trim + strip prefix + trim) and `delegateArgError(entries)` returning an actionable message for the first entry with a missing/blank id, else null | `src/delegate-tool.ts`, `tests/unit/delegate-tool.test.ts` | missing-id-actionable + blank-id-treated-as-missing | missing-id-reported; blank-is-missing |
| 3 | Normalize then validate at the top of the handler, before the target guards, plugin application, and any dispatch | `src/delegate-tool.ts`, `tests/unit/delegate-tool-more.test.ts` | no-side-effect-on-refusal + prefix-only-is-missing | no-side-effect-precedes-validation; blank-is-missing |
| 4 | Apply the same pattern to `create_caco_session`: `cwd`/`model` optional in schema, required in the handler with a message naming the missing argument(s) | `src/agent-tools.ts`, `tests/unit/agent-tools*.test.ts` | missing-required-argument oracle | missing-id-reported |

## Rationale

The incident cost three retries and a fallback to a different review path, and
none of that was caused by the delegate logic — which never ran. It was caused by
a validation layer that knew exactly what was wrong and had no way to say it.
Moving one check from the schema into the handler converts a dead end into a
one-line correction, and aligns the tool with `caco_herd`, which has quietly had
the right design all along.
