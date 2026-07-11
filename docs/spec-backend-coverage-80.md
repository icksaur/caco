# spec-backend-coverage-80

## Goals
Raise backend (`src/**`) statement coverage from **50.5%** (4763/9438) to **≥80%**
(≥7551 covered; **+2788 statements**), locked by ratcheting per-directory floors so
it cannot rot back. Frontend (`public/ts/**`, ~30%) is explicitly out of scope.
Outcome: a competent agent can safely refactor backend modules with the suite as a
guard, and the weakest area (`src/routes`, 18.8%) becomes genuinely exercised.

## Design
Four test mechanisms, chosen per module shape. Each phase ratchets the relevant
floors on completion and commits. Stop once backend ≥80% even if later phases are
partial — the phases are ordered by ROI (uncovered statements per unit effort).

**Mechanism A — hermetic fs / pure logic.** For stores and pure helpers: set a
tmp `CACO_HOME`, `vi.resetModules()`, import late, drive the real functions,
assert on returned values + on-disk JSON. Reference: `usage-state.test.ts`,
`chat-draft-store.test.ts`. No SDK, no external network. Precondition: the module
must derive its path from `STORAGE_ROOT` (fix any that hardcode `homedir()`, as
`usage-state.ts` was fixed — same prod path, now honors `CACO_HOME`).

**Mechanism B — route harness (the main lever, `src/routes` = 1621 uncovered).**
Mount the *real* router on a bare `express()` app, `vi.mock` its module-level
singletons (`sessionManager`, `sessionState`, `storage`, `./websocket`,
`dispatchState`, `idleFeed`, …) to in-memory fakes, `app.listen(0)`, drive real
requests with global `fetch`. The handler *bodies* execute → real coverage, not
just extracted helpers. Reference: `watch-route-harness.test.ts` (took `watch.ts`
16%→79% with 3 tests). Keep genuinely-pure helpers (`parseIdleQuery`,
`validateSchedulePutBody`) as direct unit tests where they already exist; the
harness covers the wiring around them. NO `supertest` dependency — `express` +
`app.listen(0)` + `fetch` is already available under Node.

**Mechanism C — SDK-faked module tests.** For SDK-coupled managers: `vi.hoisted`
a fake `CopilotClient` (start/stop/createSession/rpc.{account,models,tools}) +
`vi.mock('@github/copilot-sdk')`, plus storage/quota-poller/mcp-config-loader
stubs. Reference: `session-manager-restart.test.ts` and siblings.

**Mechanism D — tool-handler tests.** For `defineTool` wrappers AND
wait/orchestration tools (`delegate-tool`, `herd-tools`): import the tool, invoke
its `handler` with a fake `sessionRef` + mocked store/runtime deps, assert the
returned tool-result payload. The tool schema/wiring is exercised without the SDK
loop.

## Invariants
- **Backend-80 is an enforced gate, not a hope.** Vitest's `thresholds` are global
  and per-directory — neither equals "aggregate `src/**` ≥80%". A dedicated check
  (`scripts/check-backend-coverage.mjs`, wired as `npm run check:coverage`) reads
  `coverage/coverage-summary.json`, sums `src/**` statements, and exits non-zero
  below its `FLOOR`. The FLOOR is a **ratchet**: it starts at the current achieved
  level and is raised one phase at a time toward the GOAL of 80; "done" = FLOOR
  reaches 80. It runs after `npm test` (which emits the summary) and is part of the
  gate from step 0, so it prevents regression throughout the push and asserts 80 at
  completion. The FLOOR never lowers.
- **No test hits the real `~/.caco` or `~/.copilot`.** Every fs test uses a tmp
  `CACO_HOME` (or mocks fs). A test that writes to the real home is a defect.
- **Hermetic + parallel-safe.** No test depends on another's state or on a live
  server/SDK/external network/browser. A **loopback** harness server
  (`app.listen(0)` on 127.0.0.1 + `fetch`) is allowed and expected for Mechanism
  B — that is in-process, not external network. Module-level singletons are reset
  (`vi.resetModules`) or mocked; harness servers bind `:0` and close in
  `afterAll`; fs watchers + temp dirs are released in `afterAll`.
- **Coverage floors only ratchet up.** Never lower a floor to make a change pass.
- **The gate stays green** (`typecheck`, `lint:strict`, `knip`, `test`,
  `build:client`, `check:specs`) after every phase/commit.
- **Tests assert behavior, not line-execution.** Each test has a real oracle
  (returned value / on-disk bytes / mock-call args), never a bare "it ran".

## Considerations
- **Route handler async side effects.** Handlers call `broadcastEvent`,
  `dispatchMessage`, etc. Mock these to `vi.fn()` and assert call args rather than
  letting them reach real singletons. Watch for handlers that `await` a manager
  method — the fake must return a resolved promise of the right shape.
- **`initX()` registration hooks.** Some routers (`watch.ts`) defer
  `sessionState.onSessionEnd` wiring to an `initWatchRoutes()` because
  `sessionState` is a late-bound `let`. Harness must mock `sessionState` so import
  doesn't crash; call the init fn if testing the end-hook.
- **Genuinely un-unit-testable modules.** `browser-connection.ts` (123, needs a
  live Chrome), `cli-oauth.ts` (37, interactive OAuth), and the WS upgrade path in
  `websocket.ts` (subset) cannot be unit-tested without integration infra. If they
  block 80%, exclude them — but exclusion is **file-level only** (`coverage.exclude`
  globs operate on whole files, not line ranges). So: whole-file modules
  (`browser-connection.ts`, `cli-oauth.ts`) go in `coverage.exclude` with a
  one-line justification. A *subset* of a file (the WS-upgrade branch inside
  `websocket.ts`) CANNOT be glob-excluded — either (a) leave it and cover what is
  reachable, or (b) split the upgrade-only code into its own file
  (`websocket-upgrade.ts`) and exclude that file. Do **not** claim a line-subset
  glob exclude — it does not exist. Never write fake tests that assert nothing.
  Excluding whole files shrinks the denominator honestly.
- **`session-manager.ts` (559 uncovered) is the whale.** It already has ~12 test
  files at 42%. Pushing it needs branch coverage of resume/rotate/evict/cancel
  paths on the SDK fake — high effort per statement. Do it last and only as far as
  needed to clear 80%.
- **Don't over-test static strings.** `dev-docs-tool.ts` (75) is mostly a giant
  doc template; a single "builds and contains key sections" test is enough — don't
  chase its lines.

## Risks and Mitigations
- **Harness proves too brittle for a big router (e.g. `sessions.ts`, 537).** →
  De-risked: `watch.ts` prototype works. For big routers, mock at the
  singleton boundary and test handler groups incrementally; fall back to
  extracting pure helpers for branches that need deep SDK state.
- **80% not reachable without excluding hard files.** → Mitigation: the exclude
  lever (browser-connection, cli-oauth) is legitimate and pre-approved above;
  recompute the target denominator after Phase 4 and exclude with justification if
  a genuinely-untestable remnant blocks the goal.
- **Flaky harness (port/watcher leaks).** → `:0` binding, `afterAll` close, tmp
  dirs, no cross-test shared state. Run the full suite twice in the final gate to
  catch order/leak flakiness.

## Acceptance
- Observable: `npm test` emits `coverage/coverage-summary.json`; `npm run
  check:coverage` (`scripts/check-backend-coverage.mjs`) sums `src/**` statements
  and asserts they meet the ratcheting FLOOR, which reaches **80%** at completion.
  This is the enforceable oracle for "done" — not the vitest per-dir floors. No
  network/SDK/browser access during the run.
- Budgets: full gate wall-clock stays reasonable (< ~30s test step); no new
  runtime deps beyond `express`/`fetch` already present.
- Gates: `npm run typecheck && npm run lint:strict && npm run knip && npm test &&
  npm run check:coverage && npm run build:client && npm run check:specs` all green.
- Oracles: every new test asserts a concrete oracle (return value, on-disk JSON,
  or mock-call args). Floors in `vitest.config.ts` raised to within ~1.5pt of the
  achieved per-dir numbers so regressions fail the gate.

## Plan
Phases are ordered by ROI. After each: run coverage, ratchet the touched floors,
commit. Track live state in the `cov_plan` SQL table. Estimates are realizable
statements (not raw uncovered).

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | Add `scripts/check-backend-coverage.mjs` + `check:coverage` npm script; wire into gate. Set target 80. | scripts/check-backend-coverage.mjs, package.json | script exits non-zero when `src/**` < 80%, zero when ≥ | backend-80-gate |
| 1 | Mechanism A: fs stores + pure logic (~450) | applet-store, output-store, extension-store, schedule-store, file-edits-store, mcp-config-loader, surface-store, restart-manager | on-disk JSON + return values; STORAGE_ROOT-hermetic | hermetic-home, ratchet-only |
| 2 | Mechanism B: route harness — small/mid routers (~500) | watch(done), surface, shell, file-edits, workspace-api, schedule | fetch → status + JSON body; mock-call args for broadcast/dispatch | hermetic, gate-green |
| 3 | Mechanism B: route harness — heavy routers (~700) | session-messages, api, mcp-auth, sessions | fetch → status + JSON; assert manager/store fakes called with right args | hermetic, gate-green |
| 4 | Mechanism D: tool + orchestration handlers (~300) | delegate-tool, herd-tools, applet-tools, agent-tools, surface-tools, dev-docs-tool | invoke handler → tool-result payload; deps mocked | hermetic |
| 5 | Mechanism C: SDK-faked managers, as needed to clear 80% (~900) | session-auto-repair, file-watcher, mcp-discovery, terminal-manager, schedule-manager, git-edit-poller, session-manager | fake-SDK/fs state → observable manager output | no-real-sdk, ratchet-only |
| 6 | If blocking 80%: whole-file-exclude browser-connection + cli-oauth (glob, w/ justification); split `websocket-upgrade.ts` out only if its subset blocks | vitest.config.ts (+ optional websocket split) | `check:coverage` passes (backend ≥80) | honest-denominator, file-level-exclude-only |
| 7 | Final: raise all vitest floors to achieved−1.5pt; run full gate (incl. check:coverage) twice | vitest.config.ts | full gate green ×2 | ratchet-only, gate-green |

## Rationale (optional, skippable)
Backend/frontend coverage split (the observable oracle for "done"):
```ts
const j = JSON.parse(fs.readFileSync('coverage/coverage-summary.json','utf8'));
let t=0,c=0; for (const [f,m] of Object.entries(j)) {
  if (f==='total') continue;
  const rel = f.replace(process.cwd()+'/','');
  if (rel.startsWith('src/')) { t+=m.statements.total; c+=m.statements.covered; }
}
console.log('backend statements', (100*c/t).toFixed(2)+'%', `${c}/${t}`);
```
Why route harness over pure-function extraction: the routes are 1817 uncovered at
18.8%; the bulk lives *inside* handler bodies (validation, status codes, error
branches) that only execute when a request flows through the mounted router.
Extraction covers only the pieces already pulled out; it cannot reach 80% of the
routes. The harness executes the real handler with cheap singleton fakes — proven
by the `watch.ts` 16%→79% prototype.

Why not `supertest`: `express()` + `app.listen(0)` + global `fetch` (Node ≥18)
gives the same ergonomics with zero new deps and no knip friction.
