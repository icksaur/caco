# spec-frontend-coverage

## Goals
Raise frontend (`public/ts/**`) statement coverage, enforced by a
`check:frontend-coverage` gate mirroring the backend one. The denominator is fixed
**up front** by excluding the one genuinely jsdom-impossible file (`terminal-panel.ts`,
222 stmts, xterm canvas) — see Design; against that fixed denominator the baseline is
**31.3%** (1537/4906) and the recommended first goal is **60%** (+~1407 statements) —
the ceiling reachable with *jsdom* (a simulated browser in Node) without a real-browser
harness. Reaching **80%** additionally requires a browser-based layer (Playwright) with
instrumented-bundle coverage merge for surfaces jsdom cannot simulate; that is a
separate, larger investment, called out below as the one open decision. Outcome after
60%: the pure-logic helpers, the DOM-rendering UI (session panel, footer, model
selector, popups, markdown render, chat form), and the seam-mocked controllers are all
guarded by tests, so a careless refactor of the view layer fails CI.

## Design

**What "testing the frontend" means here (orientation — you said zero competence).**
`public/ts/**` is vanilla TypeScript + DOM APIs (no React/Vue). A module either (a)
transforms data (pure — `retryAsync`, `buildTerminalMarkdown`, a router's
`shouldShowAppletOnNavigation`), or (b) *drives the DOM* (queries `document`, sets
`innerHTML`, attaches `click`/`input` listeners — `session-panel`, `context-footer`,
`model-selector`). Pure code is tested like backend code. DOM code is tested by giving
Node a **fake `document`** — `jsdom` — then calling the module and asserting on the
resulting element tree (e.g. "after `render(items)`, the panel contains 3
`.session-row` elements; clicking the first dispatches `onActivate('id')`"). jsdom is
already installed and one test (`response-option-html.test.ts`) already uses it. There
is NO UI framework and NO `@testing-library`; a tiny local render/query helper is
enough (adding `@testing-library/dom` is an optional ergonomic upgrade the user may
approve, but the spec does not require it).

**Three test mechanisms (pick per module shape):**

- **FE-A — pure logic (Node env, default).** Direct import, data in → assert out. No
  DOM. Targets: `fetch-retry`, `markdown-builders`, `edit-diff`, `hostname-hash`,
  `command-registry` (search/lookup), the pure decision fns in `router`/`ui-utils`,
  `form-state`. Reference: existing `fetch-retry.test.ts`, `markdown-builders.test.ts`.

- **FE-B — jsdom render + assert (the main lever, ~70% of the code is DOM-coupled).**
  Put `// @vitest-environment jsdom` at the file top. Build the module's DOM (call its
  render fn, or set `container.innerHTML` from its HTML-builder), then assert on the
  element tree and on simulated events (`el.dispatchEvent(new Event('click'))` →
  assert the handler's effect). Targets: `session-panel`, `context-footer`,
  `model-selector`, `input-popup`, `chat-form-popups`, `markdown-renderer`,
  `adhoc-bar`, `response-option-html` (done). Reference: `response-option-html.test.ts`.

- **FE-C — seam-mocked controllers (jsdom + mocked side-effect modules).** Controllers
  that own I/O import a small set of *seam* modules: `websocket.ts` (the single WS
  connection + `onEvent`/`onStateUpdate`/`onGlobalEvent`), the fetch modules
  (`fetch-retry`, `chat-draft-api`, `history`), and `router.ts` (navigation). `vi.mock`
  those to `vi.fn()` fakes, then drive the controller in jsdom and assert DOM changes +
  that the seam was called with the right args. Targets: `chat-view-controller`,
  `chat-form-controller` (partly done), `message-streaming`, `session-state-tracker`,
  `websocket` (its dispatch/subscribe logic, mocking the raw `WebSocket` global),
  `view-controller`, `input-router`, `image-paste`.

**Mechanism choice — jsdom over happy-dom or Playwright.** jsdom is already a
dependency and already used; happy-dom would be a second, redundant DOM impl.
Playwright (real Chromium) is strictly more capable but is a heavier, slower,
separate harness — reserved for the surfaces jsdom *cannot* simulate (below), not for
the bulk UI. Per-file `@vitest-environment jsdom` pragma (NOT a global env switch) so
the fast Node-env backend suite is unaffected by jsdom's per-file setup cost.

**Enforceable gate + FIXED denominator.** `scripts/check-frontend-coverage.mjs`
(sibling to `check-backend-coverage.mjs`) sums `public/ts/**` statements from
`coverage/coverage-summary.json` and enforces a ratcheting `FRONTEND_FLOOR` (starts at
the achieved baseline, raised one phase at a time toward the goal). Wired as `npm run
check:frontend-coverage` into the `build` gate. The **exclusion set is decided up front,
NOT "when short"** — excluding files only after falling short would manufacture the goal
by moving the denominator. The fixed exclusion is exactly one file:
- `terminal-panel.ts` (222 stmts, 0% now) — xterm.js renders to a real canvas jsdom does
  not implement; unit-testing it is fake. (Its sibling `terminal-lru.ts` is a pure LRU
  and STAYS in — already ~73%.)
`main.ts` and `**/types.ts` stay excluded (already are). With that one exclusion the
denominator is **4906** statements (5128 − 222), baseline **1537/4906 = 31.3%**, and the
60% goal = 2944 covered (+1407). The FLOOR never lowers.

**`applet-runtime.ts` is NOT excluded** (304 stmts, 2.6%). Despite its applet-eval
sandbox, it has testable orchestration/error branches (load dispatch, message routing,
error/timeout handling) reachable under jsdom with the eval boundary mocked. It stays in
the denominator; Phase 4 covers its reachable branches and its irreducible eval core
simply stays uncovered (honest drag, not a hidden file). Do not exclude it categorically.

**Out of jsdom's reach.** Only `terminal-panel.ts` is categorically un-simulatable and
is the sole up-front exclusion (above). Everything else — including `applet-runtime`'s
orchestration — is measured. If a later, MEASURED finding shows another file is
genuinely all-native (not just hard), it may be added to the fixed exclusion set with a
one-line justification AND a matching FLOOR recomputation in the same commit — never a
silent "exclude to pass".

## Invariants
- **Frontend-goal is an enforced gate.** `npm run check:frontend-coverage` computes the
  `public/ts/**` aggregate and fails below its ratcheting FLOOR. The vitest global
  thresholds already include `public/ts` but are not a `public/ts`-only metric; the
  dedicated check is the source of truth for the frontend goal. FLOOR never lowers.
- **Node stays the default test env; jsdom is opt-in per file.** No global
  environment switch — the backend suite must not pay jsdom setup cost. A frontend test
  that needs the DOM declares `// @vitest-environment jsdom`.
- **Tests assert behavior, not line-execution.** Each test has a real oracle: a queried
  DOM element/attribute/text, a dispatched-event effect, a returned value, or a
  seam-mock call-args assertion. A test that renders but asserts nothing is a defect.
- **Hermetic + parallel-safe.** No real network/WS/timers-that-hang. Seam modules
  (`websocket`, fetch, `router`) and the raw `WebSocket`/`fetch` globals are mocked.
  jsdom `document` is reset between tests (fresh container per test, or
  `document.body.innerHTML=''` in `afterEach`); no test depends on another's DOM.
- **The gate stays green** (`typecheck` ×2, `lint:strict`, `knip`, `test`,
  `check:coverage`, `check:frontend-coverage`, `build:client`, `check:specs`) after
  every phase/commit.
- **No new runtime deps.** jsdom is dev-only. `@testing-library/dom`, if the user
  approves it, is dev-only too; the plan does not assume it.

## Considerations
- **jsdom gaps.** No layout/geometry (`getBoundingClientRect` → zeros),
  no real canvas, no `navigation` API in older jsdom, no `WebSocket` server. Tests must
  avoid asserting on pixel geometry and must mock `window.navigation`/`WebSocket`. Where
  a module reads geometry to decide behavior, extract that decision into a pure fn
  (FE-A) and test the fn, not the scroll.
- **DOM leakage in "pure" modules.** `app-state.ts` is mostly pure but 2 fns touch
  `document.getElementById('newChatCwd')`. Either test those under jsdom or (better,
  noted for the impl) treat the leak as a code smell and cover around it — do not
  contort a pure test to satisfy a DOM line.
- **Event-driven assertions.** The oracle for a handler is the *effect* of a dispatched
  event (`click`/`input`/`submit`), e.g. after clicking `.model-option`, the selector
  reflects the new model and the (mocked) preferences fetch was called. Simulate the
  event; assert the effect.
- **Big files are mixed.** `session-panel` (800 LOC) and `context-footer` (635) hold
  both render logic (FE-B) and event wiring (FE-C). Cover the render/format branches
  first (cheap, high yield), then the interaction wiring.
- **`command-registry` (549, 25%)** is largely pure search/registry logic — a high-yield
  FE-A target that needs no jsdom.
- **DOM types typecheck already.** The ES2020 target injects `lib.dom` by default (why
  `response-option-html.test.ts` uses `document` under `tsc --noEmit`). No tsconfig
  change needed for jsdom tests.

## Risks and Mitigations
- **jsdom brittleness / flaky async DOM.** → fresh container per test; `afterEach`
  clears `document.body`; await microtasks explicitly; run the full suite twice in the
  final gate to catch order/leak flakiness (as the backend push did).
- **60% is the jsdom ceiling; 80% needs Playwright AND coverage instrumentation.** →
  Recommended goal is 60% via jsdom. If the user wants 80%, Phase P is a SEPARATE spec —
  and note: **Playwright/browser tests do NOT feed Vitest's V8 coverage summary
  automatically.** To advance an 80% *statement* gate, Phase P must instrument the
  browser bundle (e.g. collect V8/CDP coverage or an istanbul-instrumented build) and
  MERGE it into `coverage-summary.json` before `check:frontend-coverage` runs. Without
  that merge, Playwright proves behavior but cannot move the number. Do not force jsdom
  to fake what it can't render. This fork is the one open decision (below).
- **Per-file jsdom slows the suite.** → pragma-scoped, not global; MEASURED at ~190–350ms
  env/file, parallelized (12 jsdom files = 625ms wall on 20 cores). Keep FE-A in node env
  so pure logic pays no DOM tax. Hard budget ≤ ~9s for `npx vitest run`; escape hatch is
  `happy-dom` (≈2–3× faster env, drop-in pragma) if the number creeps. Re-measure in the
  final gate.
- **A refactor is tempting mid-coverage** (e.g. de-DOM-ing app-state). → Out of scope;
  note smells, don't fix them under the coverage task (the backend push logged latent
  bugs without fixing them).

## Acceptance
- Observable: `npm test` emits `coverage/coverage-summary.json`; `npm run
  check:frontend-coverage` sums `public/ts/**` statements and asserts they meet the
  ratcheting FLOOR, which reaches the **goal (60%, or 80% if Playwright phase is
  approved)** at completion. No real network/WS/browser during the Node+jsdom run.
- Budgets: **measured** — jsdom's only cost is per-file environment setup (~190–350ms/
  file), fully parallelized across workers (20 cores here): a 12-jsdom-file / 96-test
  batch ran in 625ms wall. Only FE-B/FE-C files use jsdom; FE-A runs in the ~0-cost node
  env. **Hard budget: the full `npx vitest run` (no coverage) test-step wall-clock must
  stay ≤ ~9s** (baseline 6.58s for 2326 tests; the frontend push may add ~+2s). If a
  phase pushes it over, switch the DOM env to `happy-dom` (≈2–3× faster setup, drop-in
  pragma) before adding more. No new runtime deps.
- Gates: `npm run typecheck && npm run lint:strict && npm run knip && npm test && npm
  run check:coverage && npm run check:frontend-coverage && npm run build:client && npm
  run check:specs` all green, twice.
- Oracles: every new test asserts a concrete oracle (queried DOM node/attr/text,
  dispatched-event effect, returned value, or seam-mock call args). Backend coverage
  (`check:coverage`, floor 80) must not regress.

## Plan
Phases ordered by ROI (pure-logic first — cheapest; jsdom render next; controllers
last). After each: run coverage, ratchet the `FRONTEND_FLOOR`, commit. Track live state
in the `fe_cov_plan` SQL table. Estimates are realizable statements.

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | Add `scripts/check-frontend-coverage.mjs` + `check:frontend-coverage`; wire into gate. **Fix the exclusion set up front**: add `terminal-panel.ts` to `coverage.exclude` w/ justification. Recompute baseline (1537/4906=31.3%); FLOOR starts 31, GOAL 60. | scripts/check-frontend-coverage.mjs, package.json, vitest.config.ts | script exits non-zero when `public/ts/**` (minus fixed exclusions) < FLOOR; baseline prints 31.3% | frontend-gate, honest-denominator |
| 1 | FE-A: pure-logic modules (~350) | command-registry, fetch-retry(done), edit-diff, hostname-hash, markdown-builders(done), form-state, ui-utils pure fns, router pure decisions, terminal-lru | data-in→assert-out; ref-impl/hand cases | hermetic, node-env |
| 2 | FE-B: jsdom render/assert — small/mid (~500) | response-option-html(done), model-selector, input-popup, chat-form-popups, adhoc-bar, context-footer (render/format branches), markdown-renderer | jsdom: query rendered nodes/attrs/text | jsdom-per-file, assert-effect |
| 3 | FE-B: jsdom render/assert — session-panel render branches (~350) | session-panel (list/row/format render) | jsdom: rows rendered, labels/classes correct | jsdom-per-file |
| 4 | FE-C: seam-mocked controllers + applet-runtime orchestration (~450) | chat-view-controller, message-streaming, session-state-tracker, view-controller, input-router, image-paste, websocket dispatch/subscribe, applet-runtime (load/route/error branches, eval boundary mocked) | jsdom + mocked websocket/fetch/router; assert DOM + mock call args | hermetic, seam-mock |
| 5 | Final: raise FRONTEND_FLOOR to goal; add per-dir vitest `public/ts` floor at achieved−1.5pt; run full gate twice | vitest.config.ts, scripts/check-frontend-coverage.mjs | full gate green ×2 | ratchet-only, gate-green |
| P | (OPEN, only if 80% chosen) Playwright + instrumented-bundle coverage merge for terminal/applet/editor | NEW spec-frontend-e2e | real-browser: element visible + interaction; merged V8 coverage advances the gate | separate-spec, coverage-merge |

## Rationale (optional, skippable)
Frontend/backend split are computed the same way (sum `statements` over a path prefix
from `coverage-summary.json`); the frontend script filters `public/ts/**` (minus the
fixed exclusion) instead of `src/**`. The backend push proved the pattern (50→81.6% via
a ratcheting gate + per-mechanism sub-agents); this spec reuses it. Exact ceiling
accounting: of 5128 `public/ts` statements, exactly one file is categorically
jsdom-impossible — `terminal-panel.ts` (222 stmts, xterm canvas) — and is the sole
up-front exclusion, giving a 4906-statement denominator. `applet-runtime.ts` (304
stmts) stays IN: its orchestration/error branches are jsdom-reachable and only its
eval-sandbox core (a minority of its lines) is irreducible drag. There is NO CodeMirror
module under `public/ts` (xterm is the only editor/terminal native dep, in
`terminal-panel.ts` + the pure `terminal-lru.ts`). So 60% is "everything jsdom can
honestly reach against the 4906 denominator"; 80% is "60% + a Playwright phase whose
browser coverage is instrumented and merged into the summary." The user decides which
goal; the spec ships the 60% plan and leaves Phase P as an explicitly-separate follow-on.

**Open decision for the user:** goal = **60% (jsdom only, this spec)** or **80% (adds a
Playwright e2e phase, separate spec + a new dev dependency + slower CI)**? Default: 60%.
