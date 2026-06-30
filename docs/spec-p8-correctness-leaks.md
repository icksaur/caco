# P8 — Smaller correctness / leak fixes

Final phase of the brutal review remediation. A grab-bag of independent
Med/Low findings from `code-review-backend.md` and `code-review-frontend.md`,
grouped into 5 commit-sized slices. Rubric priority (`doc/code-quality.md`):
make-illegal-states-unrepresentable > encapsulate > assert > test-seam > comment.

Each slice ships red→green oracle(s) where a test seam exists, runs all gates
(typecheck ×2, lint:strict, knip, vitest), and commits with a facts-only
message. Slices are independent and may land in any order.

## Slice A — Scheduler: invalid schedule throws (BE)

**File:** `src/schedule-manager.ts`.

**Problem.** `calculateNextRun()` silently returns `now + 1h` on two paths: a
cron expression that fails to parse (lines 234-238) and any unknown/!-matching
schedule shape (lines 245-246). A config or API change silently alters run
cadence to hourly instead of failing loud. (The review's secondary note — a
double `validateScheduleInterval` call — is already resolved; only one call
remains at line 64. Do not re-add it.)

**Design.** Rename to `calculateNextRun` → keep the name but make it total over
*valid* input and throwing on invalid:
- Cron parse failure → `throw new Error(...)` (no 1h fallback).
- Unknown shape (neither a cron with `expression` nor an interval with
  `intervalMinutes`) → `throw new Error(...)`.
- Valid cron / valid interval → unchanged return.

**Callers — verified against code (review-confirmed):**
- `checkSchedules` (schedule-manager.ts:64) calls `validateScheduleInterval`
  and `continue`s (skips) before a slug reaches `dueTasks`/`executeSchedule`.
  `validateScheduleInterval` rejects unparseable cron (`'Invalid cron expression'`)
  and bad interval shapes — the same inputs `calculateNextRun` throws on. So
  every `calculateNextRun` inside `executeSchedule` runs on an already-validated
  schedule and is total in the normal tick.
- **Defense for the WARRANTED "aborts remaining due tasks":** wrap each
  `await executeSchedule(slug)` in the `checkSchedules` dueTasks loop
  (schedule-manager.ts:88-90) in its own try/catch that logs and continues, so a
  should-never-happen throw from one slug (incl. an escaped calc throw from the
  error-path calc at line 178, which sits *inside* executeSchedule's catch)
  cannot abort the remaining due tasks. `triggerSchedule` already wraps
  `executeSchedule` in try/catch → `{ success: false, error }`.
- **Route callers (schedule.ts):** POST validates via `validateScheduleInterval`
  at line 126 *before* `saveDefinition`(161), so the calc calls at 165/177 are
  total. Both the POST and PATCH handlers already wrap their whole body in
  try/catch → `res.status(500).json({ error: message })` (192-194, 256-258), so a
  calc throw from a hand-edited/legacy-invalid on-disk schedule (the only un-pre-
  validated path, PATCH re-enable at 241) fails loud with a descriptive 500 and
  no silent hourly — and `checkSchedules` then skips that invalid schedule via the
  line-64 gate. **No route code change required.** (Proper load-time
  schedule-shape validation is the deferred schedule-store schema finding — out
  of P8 scope.)

**Oracle** (`tests/unit/schedule-next-run.test.ts`, new):
- Invalid cron expression → `calculateNextRun` throws (red: today returns a
  Date ~1h out).
- Unknown shape (`{ type: 'interval' }` with no `intervalMinutes`) → throws.
- Valid cron (`0 9 * * *`) → returns the next 09:00 from a fixed `from`.
- Valid interval (`intervalMinutes: 60`) → returns `from + 60m`.

## Slice B — Correlation metrics: single call-record source (BE)

**File:** `src/correlation-metrics.ts`.

**Problem.** `isAllowed()` builds `allTimestamps = this.chain.map(() => now)`
(line 62) — synthetic identical timestamps — and passes them to
`RunawayRulesEngine.checkCall` as `callTimestamps`. The engine's rate rule
(rules-engine.ts:88-96) therefore sees every prior call as occurring *now*,
which is fake data. Rate is represented twice: once in a separate
`RateAggregator`, once via these synthetic timestamps. Two representations kept
in sync by hand.

**Design (make-unrepresentable).** Replace `chain: string[]` + `rateAggregator`
with a single source of truth:

```
private records: { sessionId: string; timestamp: number }[] = [];
```

- `recordCall(id)` pushes `{ sessionId: id, timestamp: Date.now() }`.
- `isAllowed(id)` derives `chain = records.map(r => r.sessionId)` and
  `callTimestamps = records.map(r => r.timestamp)` and passes BOTH (real) to
  `checkCall`. The engine's rate rule now operates on real timestamps; the
  separate pre-check via `RateAggregator` is removed (the engine already owns
  depth + age + rate, and `isAllowed` runs before `recordCall` so the engine's
  `+1 for new call` reproduces the old aggregator semantics).
- `getMetrics()` derives `chainLength = records.length`, `chain` from records,
  `callCount` = records whose timestamp ≥ `now − rateLimit.windowSeconds*1000`,
  `ageSeconds` from `startTime`.
- Drop the `RateAggregator` import/field. `RateAggregator` stays in the codebase
  (used elsewhere / its own tests); only `CorrelationMetrics` stops using it.

**Contract preserved (one deliberate wording change).** Public API (`isAllowed`,
`recordCall`, `getMetrics` shape with
`correlationId/chainLength/ageSeconds/callCount/chain`, `isExpired`) is
unchanged. **One observable change:** the rate-rejection `reason` now comes from
the engine (`'Call rate limit exceeded: …'`, rules-engine.ts:91-94) instead of
the dropped aggregator's `'Rate limit …'`. The existing assertion
`tests/unit/correlation-metrics.test.ts:73` (`toContain('Rate limit')`) must be
updated to `toContain('rate limit')` to match the engine wording. The `reason`
string is log/debug-only (session-manager.ts:1504 uses the boolean), so this is
safe.

**Oracle** (extend `tests/unit/correlation-metrics.test.ts`):
- Real-timestamp rate: with a strict rate (e.g. 2 calls / 60s) and
  `vi.useFakeTimers()`, record 2 calls, advance time past the window, then
  `isAllowed` must be allowed (proves the window slides on *real* recorded
  timestamps). Red under synthetic timestamps: all prior calls counted as
  `now`, so the window never clears and the call is wrongly rejected.
- `getMetrics().callCount` reflects only in-window records after advancing time.

## Slice C — Workflow facade: typed accounting wrapper (BE)

**Files:** `src/workflow/facade.ts`, `src/workflow/runner.ts`.

**Problem.** `runner.ts` (≈146-154) wraps the facade in a `Proxy` over
`Record<string, unknown>` that coerces *every* property to an async function.
A future synchronous facade member silently changes contract and the proxy
erases the API shape TypeScript could enforce.

**Design (make-unrepresentable).** Add to `facade.ts`:

```
export function wrapFacadeForAccounting(
  facade: Facade,
  account: (value: unknown) => void,
): Facade
```

an explicit object literal that delegates each of the 8 known methods. `account`
is a side-effecting byte counter (NOT a transformer): each wrapped method does
`const r = await facade.X(args); account(r); return r;`, so the wrapper's return
types stay exactly `Promise<IndexResult>` / `Promise<ReadResult>` / … and the
literal typechecks as `Facade`. (Piping the value *through* `account: unknown =>
unknown` would NOT typecheck — the method returns must stay typed.) Because the
return type is `Facade`, adding/removing/changing a method forces the wrapper to
be updated — a compile error instead of silent drift. The harness string in
`runner.ts` imports `wrapFacadeForAccounting` from the same module URL as
`createFacade` (`facadeModuleUrl()`, runner.ts:122-134) and builds `const caco =
wrapFacadeForAccounting(__rawFacade, __account)`, deleting the `new Proxy(... as
Record<string, unknown> ...)` block. `__account` keeps its byte-counting body.

**Oracle** (extend `tests/unit/workflow-facade.test.ts`):
- `wrapFacadeForAccounting` invokes `account` once per call with the method's
  resolved value, and returns that value unchanged (drive a fake `Facade` whose
  `list`/`read` return known payloads; assert `account` received them and the
  caller got the same result).
- Type-level guard is implicit (compile fails if a method is missing) — note it
  in the test comment; no runtime assertion needed.

## Slice D — FE applet stale-async guards (FE)

**Files:** `applets/git-status/script.js`, `applets/text-editor/script.js`,
`applets/image-gallery/script.js`.

**Problem (same race family).** Each applet's async loader has no epoch/abort.
A slower earlier response can overwrite the UI for a newer
path/repo/directory after the user navigated. For the text editor this is also
a *data* hazard: Save writes `editorView` contents to `currentFilePath`, but a
stale `loadFile` can replace the editor body after `currentFilePath` changed,
so Save persists stale content to the current path.

**Design (test-seam / make-unrepresentable per applet).** Module-level
monotonic epoch counter; each loader captures its epoch at entry and applies
results (DOM writes, editor replacement, state) only if its epoch is still
current AND the keying identity still matches:
- **git-status `refresh()`**: capture `myEpoch = ++refreshEpoch` and
  `myRepo = repoPath` at entry. Bail before every UI mutation block (success,
  not-a-repo, error, finally spinner-off) if `myEpoch !== refreshEpoch` **OR**
  `myRepo !== repoPath`. The identity check is required because navigating to an
  empty path does NOT call `refresh()` or bump the epoch (script.js:598-612), so
  an in-flight refresh for the old repo must still be discarded by repo identity.
  Also capture the cwd once (`const cwd = myRepo`) and pass it explicitly to the
  `runGit(...)` calls this refresh makes, instead of letting `runGit` read the
  mutable global `repoPath` (script.js:55-60) — otherwise a mid-flight nav makes
  the old refresh query the new repo. The `finally` must only clear the spinner
  for the latest+matching refresh.
- **text-editor `loadFile(path)`**: capture `myLoad = ++loadEpoch`; after each
  `await`, bail if `myLoad !== loadEpoch`. On success, record the loaded path
  in a module var `editorPath = path` set atomically with `createEditor`. The
  Save handler asserts `editorPath === currentFilePath` before writing; if they
  differ, abort Save with a status message (a load is in flight / mismatched).
- **image-gallery `loadGallery(dirPath)`**: capture `myLoad = ++galleryEpoch`
  and `myDir = dirPath`; in BOTH the `.then` and the `.catch`
  (script.js:85-88), bail if `myLoad !== galleryEpoch` before touching the
  grid/observer — a stale fetch *error* must not overwrite the current UI either.

**Testing.** These `.js` applet files load DOM globals and `window.appletAPI`
and are not in the TS unit graph; existing applet tests
(`files-applet-*.test.ts`) test extracted pure helpers, not the script bodies.
The stale-guard logic here is small and DOM-coupled; an extracted helper would
be more indirection than value. **Oracle approach:** add one focused test
`tests/unit/applet-stale-guard.test.ts` that extracts the *pure* epoch-guard
predicate used by all three (a tiny `isCurrent(captured, current)` shared
pattern) only if it can be shared without contorting the applets; otherwise
verify by code review + manual smoke (rapid path switch shows only the latest
result) and document that these are DOM-bound. Prefer the shared predicate:
define `function staleGuard()` inline per applet (no cross-file dependency, applets
load in isolation), and unit-test the predicate shape in isolation. Keep the
guard trivially correct (strict `!==` on a captured number).

> Decision: do NOT introduce a shared module across applets (they load as
> independent script bodies with no import system). Each applet gets its own
> 2-line epoch guard. Correctness is by inspection + the predicate is too small
> to meaningfully unit-test across the DOM boundary. The text-editor Save
> `editorPath === currentFilePath` assertion is the one behavior worth a note in
> the commit; it makes the stale-write unrepresentable.

## Slice E — FE ownership tokens, CSS fail-closed, dead code (FE)

**Files:** `public/ts/command-registry.ts`, `public/ts/extension-api.ts`,
`public/ts/applet-runtime.ts`, `applets/mcp-servers/script.js`.

**E1 — Command disposer ownership.** `registerCommand(cmd)` returns
`() => commands.delete(cmd.name)` which deletes by name unconditionally. If a
second registration overwrites the name (or an extension reloads after another
claimed the same name), the disposer deletes whoever currently owns the name.
**Fix (make-unrepresentable):** the disposer captures the `cmd` object and
deletes only if `commands.get(name) === cmd` (identity check) — a superseded
registration's disposer becomes a no-op. Update `extension-api.ts`
`registerCommand` to set `source: 'extension'` (not `'built-in'`); `Command.source`
already allows `'extension'`.

**E2 — CSS scoping fail-closed.** `scopeAppletCSS` (applet-runtime.ts:813)
returns the *unscoped* `css` when `temp.sheet` is null, leaking an applet's
styles globally. **Fix (fail-closed):** on null sheet, `console.error` and
return `''` (drop the applet's CSS) rather than returning unscoped CSS. Losing
one applet's styling is strictly safer than leaking it across all applets.

**E3 — Dead code.** `applets/mcp-servers/script.js` defines
`renderClientIdForm(escapedId)` (line 98) which is never called (only its
definition + handlers for never-rendered elements). Delete it.

**E4 — DROPPED (was: share STORAGE_ROOT).** Investigation: `STORAGE_ROOT`
(storage-paths.ts:14) is captured at *import time*, whereas
`browser-config.ts`'s local `storageRoot()` reads `process.env.CACO_HOME`
*dynamically* on each call. `tests/unit/browser-config.test.ts` sets
`CACO_HOME` in `beforeEach` *after* importing the module and relies on that
dynamic read. Importing `STORAGE_ROOT` would break those tests and remove
intended runtime-override behavior. The local dynamic read is correct; the
minor duplication is acceptable. **Do not change `browser-config.ts`.**

**Oracle** (`tests/unit/command-ownership.test.ts`, new; extend an
applet-runtime test if one exists for E2):
- E1: register `foo`(A); register `foo`(B, overwrites); dispose A → `get('foo')`
  still returns B (red: today A's disposer deletes B). Dispose B → gone.
- E2: stub `scopeAppletCSS` path where `temp.sheet` is null returns `''` not the
  input (extract the null-branch into a tiny testable predicate, or assert via a
  jsdom seam if available). If not cleanly testable under the test env, fold E2
  into code review and pin E1 with the unit test.

## Considerations

- **Scope discipline.** P8 is cleanup; do not refactor adjacent code. The
  scheduler schema-validation finding (`schedule-store.ts` schema at load) and
  the `caco-event-queue` lifecycle finding are tracked separately / already
  handled by P6's SessionRuntime work and are NOT in P8.
- **Applet JS is untyped and DOM-bound.** Accept code-review + smoke validation
  for Slice D's DOM writes; the value is the guard correctness, which is
  inspection-trivial.
- **No behavior change for valid inputs.** Slices A/B/C must be pure-internal:
  identical outputs for valid schedules, normal call flows, and facade calls.

## Risks

- **A:** a throw that escapes `executeSchedule` could crash a tick. Mitigation:
  wrap the persistence calc; `checkSchedules` already guards with try/finally.
- **B:** dropping `RateAggregator` from `CorrelationMetrics` could change rate
  semantics. Mitigation: the engine's rate rule with real timestamps + `+1`
  reproduces the aggregator; existing tests pin depth/rate/getMetrics.
- **C:** harness string edits run in a child process — a typo surfaces only at
  runtime. Mitigation: `workflow-runner.test.ts` exercises the real child;
  keep the wrapper import path identical to `createFacade`.
- **E2:** returning `''` removes styling for an applet whose CSS can't be
  parsed. Acceptable: that path indicates a real CSS/DOM failure and global
  leakage is worse.

## Plan

1. Slice A — scheduler throw + oracle.
2. Slice B — correlation single-source + oracle.
3. Slice C — typed facade wrapper + oracle.
4. Slice D — three applet epoch guards + Save assert (review/smoke).
5. Slice E — command ownership + CSS fail-closed + dead code + oracle.
6. Background code-review (gpt-5.5, ref `code-quality.md`); apply warranted.

P8 closes the brutal-review roadmap.
