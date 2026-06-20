# P5 — Typed disk-read results (resume-old-session disappearance / data loss)

## Goal

Replace silent `null` / `[]` / `{name:''}` sentinels on disk reads with a typed
result that distinguishes **missing** (legitimately absent → safe to default)
from **corrupt** (parse/IO failure → must NOT trigger a destructive default or a
silent drop). The two failure modes currently collapse into one, causing:

- **Session disappearance:** a corrupt `events.jsonl` makes `readSessionEvents`
  return `[]`, and `_discoverSessions` skips it (`if (events.length === 0)
  continue`), so the session vanishes from the list; `hasMessages` returns false
  so auto-resume skips it.
- **Metadata data loss:** `getSessionMeta` returns `undefined` on corrupt
  `meta.json`, and ~20 read-modify-write sites do `getSessionMeta(id) ?? {name:''}`
  then `setSessionMeta(...)`, overwriting a recoverable file with empty defaults —
  wiping custom name, folder, model, context, budget, etc.
- **Schedule misfire / disappearance:** corrupt `last-run.json` → `loadLastRun`
  returns null → `nextRun=now` → unintended immediate run; corrupt
  `definition.json` → schedule silently never runs.
- **Repair clobber:** `session-auto-repair` rewrites `events.jsonl` in place with
  no backup and no validation that the rewrite is parseable.

## Non-goals

- Concurrent-writer atomicity for meta (token-refresh-style races) — that is P7's
  `updateMcpServerAuth` mutation-boundary work. P5 introduces a single
  `updateSessionMeta` boundary but does not add file locking.
- A general migration of every `JSON.parse(readFileSync(...))` in the codebase.
  P5 is scoped to the four data-loss / disappearance hot paths named above.

## Shared primitive

New `src/disk-read.ts`:

```ts
export type DiskRead<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'missing' }
  | { ok: false; kind: 'corrupt'; error: Error };

/** Sync JSON read. missing → file absent; corrupt → read or parse threw. */
export function readJsonFileSync<T>(path: string): DiskRead<T>;

/** Async JSON read (fs/promises). ENOENT → missing; else throw → corrupt. */
export function readJsonFile<T>(path: string): Promise<DiskRead<T>>;
```

- `missing` is detected by `existsSync` (sync) or `ENOENT` (async). Any other
  read error or a `JSON.parse` throw is `corrupt` with the captured `Error`.
- This is the only place the missing/corrupt classification lives, so callers
  cannot accidentally conflate them (make-unrepresentable: the union has no
  "empty" member that doubles as both).
- **Parseable ≠ valid domain data.** `readJsonFileSync` only guarantees the bytes
  parsed as JSON; it can still yield `null`, an array, or a primitive. Callers
  that expect an object (notably `readSessionMeta`) must apply a minimal runtime
  shape guard (non-null `typeof === 'object'`, not an array) and treat a
  structurally invalid value as `corrupt`, not `ok`. The generic reader does not
  encode the domain shape.

`session-auto-repair` reads JSONL, not a single JSON doc, so it does not use
`readJsonFile`; it gets its own validate/backup helper (slice 4).

## Slice 1 — Session metadata: no destructive overwrite (highest value)

Split into two commits to bound blast radius: **1a** introduces the boundary and
migrates the in-module background clobber sites; **1b** migrates the external
route/tool/session-manager sites.

### 1a — boundary + in-module mutators

`src/session-meta-store.ts`:

- Add `readSessionMeta(sessionId): DiskRead<SessionMeta>` built on
  `readJsonFileSync`. Apply a runtime shape guard: a parsed value that is not a
  non-null plain object → `corrupt` (not `ok`). On the `ok` path apply the
  existing `kind` back-fill.
- Keep `getSessionMeta(sessionId): SessionMeta | undefined` as a thin wrapper:
  `ok → value`, `missing → undefined`, **`corrupt → undefined` but log loudly**
  (read-only callers stay best-effort; they never write back).
- Add the mutation boundary:

  ```ts
  export function updateSessionMeta(
    sessionId: string,
    mutate: (meta: SessionMeta) => SessionMeta | void,
    opts?: { createIfMissing?: boolean }  // default true
  ): boolean
  ```

  Behaviour:
  - `readSessionMeta` →
    - `corrupt`: **back up once** to `meta.json.corrupt-<ts>` (only if no backup
      exists), log an error, and **return `false` WITHOUT writing**. The corrupt
      file is preserved for manual recovery; defaults never clobber it.
    - `missing`: if `createIfMissing === false` → return `false` without writing
      (preserves "do not create" semantics); else start from `{ name: '' }`.
    - `ok`: use the value.
  - Apply `mutate`, `setSessionMeta`, return `true`. Returning `false` means
    "nothing was persisted" (corrupt, or missing-and-not-creating).

- Rewrite the in-module automatic mutators — `markSessionObserved`,
  `markSessionIdle`, `setSessionIntent` — to use `updateSessionMeta`. These fire
  constantly in the background and are the primary clobber vector. They are
  best-effort: log and ignore a `false` return.
- `src/unobserved-tracker.ts` (2 RMW sites) migrate here too (same best-effort
  class).

### 1b — external mutation sites

Migrate the remaining read-modify-write sites (the `getSessionMeta(id) ?? {name:''}`
+ `setSessionMeta` pattern) to `updateSessionMeta`, routing **guarded
`if (meta) setSessionMeta(...)` sites through `{ createIfMissing: false }`** so the
boundary owns the create-or-skip decision and the bad RMW pattern is no longer
reachable:

  - `src/offer-action-tool.ts` (1)
  - `src/routes/api.ts` (1), `src/routes/sessions.ts` (rename/folder/lastUsedAt/context)
  - `src/routes/session-messages.ts` (steer/context/lastUsedAt/cancel)
  - `src/session-manager.ts` (model, cwd, budget set/restore, reasoningEffort)

  Read-only `getSessionMeta` callers (sorting, display, parent lookup) are left
  unchanged.

  Mechanical translation: `const m = getSessionMeta(id) ?? {name:''};
  setSessionMeta(id, {...m, x});` becomes `updateSessionMeta(id, m => { m.x = ...; });`.

### `false`-return handling (required, per migration class)

A corrupt `meta.json` makes `updateSessionMeta` refuse the write. Callers MUST
handle that refusal correctly rather than reporting phantom success:

- **Background best-effort** (observed/idle/intent, unobserved-tracker): log and
  ignore `false`. No user-visible contract.
- **User/API mutations** (rename, folder, model, context-budget,
  reasoningEffort): check the `false` return and **surface an error / abort
  follow-on side effects**. Several of these have external side effects beyond the
  write — context-budget set/restore disconnects+resumes the SDK session,
  reasoningEffort issues SDK RPCs, route handlers return HTTP success. For these:
  - **Persist metadata BEFORE the external side effect** where ordering allows, so
    a refusal short-circuits before the SDK is touched; if `false`, return an
    error and do not perform the side effect.
  - Where the side effect must precede the write, document the lack of rollback
    and at minimum return a non-success status so the UI does not show a silent
    win.
- Tests must cover at least one route/API mutation and one session-manager
  mutation where corrupt meta causes a refusal (not silent success).

This is the largest slice; 1a and 1b each compile and pass gates independently.

## Slice 2 — Session events: no silent disappearance

`src/sdk-session-store.ts`:

- Add `readSessionEventsResult(sessionId): DiskRead<SessionEvent[]>`. The JSONL
  reader tracks `totalNonEmptyLines` and `parseFailures`:
  - file absent → `{ ok:false, kind:'missing' }`
  - `readFileSync` throws → `{ ok:false, kind:'corrupt', error }`
  - **non-empty content but ZERO lines parsed (all malformed)** →
    `{ ok:false, kind:'corrupt', error }`. This is the key fix: an all-garbage
    file must NOT look like an empty session.
  - otherwise → `{ ok:true, value }` (a *partial* parse — some lines parsed, some
    skipped — is still `ok`; we recovered usable events).
- Keep `readSessionEvents(): SessionEvent[]` as a best-effort wrapper
  (`ok → value`, else `[]`) for the many display/model callers.
- Add `readLastTurnsResult(sessionId, maxTurns, maxEvents): DiskRead<{ events;
  totalLines; skipped }>` with the same missing/corrupt classification
  (stat/read throw → corrupt; non-empty-but-zero-parsed → corrupt). Keep the
  existing `readLastTurns` returning the bare `{ events, totalLines, skipped }`
  (best-effort wrapper) so other callers are unaffected; the cache stays in the
  underlying implementation.

`src/session-manager.ts`:

- `_discoverSessions`: switch to `readSessionEventsResult`.
  - `missing` → `continue` (no session data, correct skip).
  - `ok` with `events.length === 0` → `continue` (truly empty).
  - `ok` non-empty → register as today (cwd from `events[0]` / meta / workspace).
  - **`corrupt` → still register the session** (cwd from meta override or
    workspace if available, else null) and log loudly. A transient read failure or
    an all-malformed file must not erase a session from the UI.
- `hasMessages(sessionId)`: on `corrupt`, return `true` (unknown but present —
  do not let auto-resume skip a session whose history merely failed to read);
  `missing`/empty → false as today.

`src/routes/websocket.ts`:

- `streamHistory`: read via `readLastTurnsResult`. On `corrupt`, instead of
  silently streaming nothing, emit a diagnostic event before `historyComplete`
  (mirror the existing `caco.truncated` pattern — e.g. a `session.error` /
  `caco.history_error` event with a short message) so the user sees "history
  failed to load" rather than an empty chat. `missing` → behave as the current
  empty path. `ok` → stream as today.

## Slice 3 — Schedules: distinguish corrupt from absent

`src/schedule-store.ts`:

- `loadDefinition` / `loadLastRun` return `DiskRead<...>` (or add
  `loadDefinitionResult`/`loadLastRunResult` and keep thin `null` wrappers if the
  blast radius in `routes/schedule.ts` is too wide — prefer typed results with
  wrappers to bound churn).
- `src/schedule-manager.ts`:
  - `checkSchedules`: on `corrupt` definition → **skip + log error** (do not treat
    as enabled, do not delete). On `corrupt` last-run → **do NOT default
    `nextRun=now`** (which would force an immediate unintended run); skip this tick
    and log, leaving the file for inspection.
  - `executeSchedule`: on `corrupt` definition → log error + return (as today for
    missing), never proceed with a half-read definition.
- `routes/schedule.ts`:
  - Display/GET callers: corrupt surfaces as an error/diagnostic rather than
    "not found"; minimally, keep current behaviour but log corrupt distinctly.
  - **Mutation routes (`PUT`/`PATCH /schedule/:slug`)**: a corrupt
    `definition.json` must NOT be treated as missing nor overwritten by a
    defaults-merged write. On corrupt definition → return a diagnostic error
    (409/500), no overwrite, unless the request is an explicit full replace. A
    corrupt `last-run.json` is never opportunistically overwritten except via a
    deliberate repair/reset action.
  - (UI parity for the corrupt state is out of scope; correctness of the
    scheduler loop and the mutation routes is in scope.)

## Slice 4 — Auto-repair: backup + validate before destructive write

`src/session-auto-repair.ts` has four in-place `writeFileSync(eventsPath, ...)`
sites (ephemeral fix, displayName fix, synthetic injection, truncation). Add one
helper and route all four through it:

```ts
function commitRepairedEvents(eventsPath: string, newContent: string): boolean
```

- Validate `newContent` is parseable JSONL: every non-empty line `JSON.parse`s.
  If any line fails, **log loudly and return false WITHOUT writing** (the repair
  did not actually produce valid content).
- Before the first successful overwrite, write a backup of the **original
  on-disk content** (captured at function entry, NOT the already-mutated
  `newContent`) to `events.jsonl.bak-<ts>` (single backup per repair invocation).
  The backup is the recovery path if a repair makes things worse.
- Only then `writeFileSync(eventsPath, newContent)`.

Each repair branch returns its existing success string only when
`commitRepairedEvents` returns true; otherwise it returns `null` (no repair) so
the outer retry loop gives up instead of looping on an unwritten/!invalid state.

## Slice 5 — Quota poller (assessment, likely no-op)

`src/quota-poller.ts` already: sets `lastPolledAt` only on success (so failures
are retried, not cached as "no data"), and skips `updateUsage` on RPC throw.
The "indistinguishable from no-data" risk is not realized here. **Plan: no code
change**; document this assessment in `plan.md` so the roadmap line is closed
deliberately, not forgotten. If review disagrees, the minimal change is a guard
that ignores an `ok`-but-empty `quotaSnapshots` rather than treating it as a real
zero.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `updateSessionMeta` migration changes create-or-skip semantics at a site | Audit each migrated site; preserve `if (meta)` guards where the old code intentionally did not create defaults. Covered by tests per site class. |
| `corrupt → register session` in discovery surfaces a broken session the user can't open | Acceptable and strictly better than silent disappearance; the session was already on disk. Opening it exercises the SDK/auto-repair path, which is the correct place to handle it. |
| `hasMessages corrupt → true` auto-resumes a broken session on boot | Auto-resume already tolerates resume failure; a corrupt session resuming and failing loudly is better than silently vanishing. |
| Backup files accumulate in session dirs | Single backup per repair invocation, timestamped; cleanup is out of scope (manual). Not on a hot loop. |
| Large blast radius in slice 1 | Split commit by file group; each compiles and tests independently. Mechanical translation keeps diffs reviewable. |
| `corrupt` backup write itself fails (disk full) | `updateSessionMeta` still returns false without clobbering; backup failure is logged but does not force the destructive write. |

## Test plan

- `tests/unit/disk-read.test.ts`: missing vs corrupt vs ok for sync + async, using
  real temp files (write garbage → corrupt; absent → missing; valid → ok;
  non-null-object guard for the meta consumer).
- `tests/unit/session-meta-store.test.ts`: `updateSessionMeta` on a corrupt
  `meta.json` does NOT overwrite it, writes a `.corrupt-<ts>` backup, returns
  `false`; on missing creates from defaults (and returns `false` without writing
  when `createIfMissing:false`); on ok mutates+persists. Verify
  `markSessionObserved` no longer clobbers a corrupt file (RED without fix).
- **`false`-handling**: a route/API mutation and a session-manager mutation each
  surface the refusal (no silent success / no SDK side effect) when meta is
  corrupt.
- `tests/unit/sdk-session-store.test.ts` (or extend existing): corrupt events →
  `readSessionEventsResult` corrupt; **all-malformed non-empty file → corrupt**
  (not ok-empty); partial parse → ok; `readSessionEvents` still `[]` best-effort;
  `readLastTurnsResult` corrupt on all-malformed/read-throw.
- Discovery test (session-manager seam): a session whose `events.jsonl` read
  throws / is all-malformed stays in the cache instead of being dropped.
- History test: `streamHistory` on a corrupt session emits the diagnostic event
  (not a silent empty stream) before `historyComplete`.
- `tests/unit/session-auto-repair.test.ts`: `commitRepairedEvents` refuses to
  write unparseable content and writes a backup (of original) before a valid
  overwrite.
- Schedule manager: corrupt `last-run.json` does not force `nextRun=now`; corrupt
  `definition.json` is skipped (not treated as enabled).

## Acceptance

- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.frontend.json`,
  `npx eslint . --max-warnings 0`, `npx vitest run` all green.
- New tests above present and verified RED→GREEN where a behaviour bug exists.
- `plan.md` P5 updated per slice, including the quota-poller no-op decision.

## Commit slicing

1. `disk-read.ts` + slice 1a (meta-store boundary + in-module/unobserved migrations).
2. Slice 1b (external route/tool/session-manager meta migrations + `false`-handling).
3. Slice 2 (events + last-turns results, discovery/hasMessages, history diagnostic).
4. Slice 4 (auto-repair backup+validate).
5. Slice 3 (schedules) + slice 5 note.

Each commit compiles and passes gates independently.
