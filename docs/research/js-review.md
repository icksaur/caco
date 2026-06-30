# JS/TS code review — Caco

Reviewer: experienced JS/TS dev, focused on idiomatic patterns, simplicity,
coupling, and maintainability. Findings only; no rewrites proposed.

## 1. Headline observations

The codebase is in genuinely good shape for a 3-person project iterating fast.
Modules are typically small, leaf-shaped, and pure-ish where it matters
(`panel-state.ts`, `usage-state.ts`, `dispatch-events.ts`, `quota-poller.ts`).
The `src/storage.ts` façade is a nice example of breaking up a god-module
while keeping import sites stable.

The visible debt is concentrated in three places: (1) the front-end DOM/event
layer where an old `event-inserter.ts` was superseded by `dom-regions.ts` but
left behind verbatim, (2) shared types (`SessionEvent`, `QuotaSnapshot`,
`ActiveSession`) that were duplicated rather than imported, and (3)
`session-manager.ts` at 1470 lines, which has accumulated `as unknown as { rpc: … }`
casts because the SDK client isn't typed at the consumer boundary. Server
modules also reach down into `routes/websocket.ts` to broadcast events, which
flips the usual layering.

Nothing here is on fire. The single biggest win is deleting
`public/ts/event-inserter.ts` and its test (~400 LOC, zero behavior change).

## 2. Findings

### Idiomatic patterns

#### Verbose `typeof window !== 'undefined' && window.fn(...)` where `?.` already works
**Where:** `public/ts/dom-regions.ts:384-385, 395-396, 416-417, 469-470, 493-494`; same pattern in `event-inserter.ts:129-130, 140-141, 163-164, 210-211, 228` (but see "dead code" below).
**What's wrong:** Ten copies of the same five-line guard:
```ts
if (typeof window !== 'undefined' && window.renderMarkdownElement) {
  window.renderMarkdownElement(element as unknown as Element);
}
```
The same module already does `window.renderMarkdownElement?.(element)` in `streaming-markdown.ts:52, 150`. The `as unknown as Element` cast is also unnecessary — `HTMLElement extends Element`.
**What to do:** Replace each call with:
```ts
window.renderMarkdownElement?.(element);
```
The `typeof window` check is only meaningful in code that genuinely runs in Node; `dom-regions.ts` is browser-only (it touches `document` unconditionally elsewhere).
**Impact:** ~30 LOC, deletes a category, removes 10 `as unknown as` casts. Low risk.

#### `(window as unknown as { navigation?: Navigation }).navigation` repeated
**Where:** `public/ts/router.ts:44, 250, 329`.
**What's wrong:** Three identical double-casts to discover the Navigation API. Same trick in `event-inserter.ts:76`, `dom-regions.ts:329` for `DOMPurify`.
**What to do:** Either (a) `declare global { interface Window { navigation?: Navigation } }` in `router.ts` and just write `window.navigation`, or (b) a one-liner local helper:
```ts
const nav = (): Navigation | undefined => (window as { navigation?: Navigation }).navigation;
```
The single-cast `as { navigation?: Navigation }` works because TS already widens `window` to `unknown`-ish at the property-access boundary; the `as unknown as` double bounce isn't needed.
**Impact:** ~6 LOC, low risk. The global `declare` is the more idiomatic move.

#### Dynamic `await import('fs')` / `await import('os')` for stdlib modules
**Where:** `src/routes/sessions.ts:449, 698-700, 752-755`; `src/routes/api.ts:309, 316`; `src/session-manager.ts:1058`.
**What's wrong:** Built-in Node modules are loaded lazily with `await import(...)` despite there being no circular-dep reason. The `sessions.ts` import landscape is the worst — `mkdtempSync`, `cpSync`, `rmSync`, `readFileSync` etc. all dynamically imported inside route handlers, sometimes with single-letter aliases (`ex`, `rd`, `rf`, `wf`) to dodge name collisions with route-level imports of the same functions.
**What to do:** Hoist these to top-level static imports. Use `import` aliases (`readFileSync as readFile`) if there is a real name collision; in practice there isn't.
**Impact:** ~20 LOC, low risk, removes a misleading pattern (every `await import()` reads like a circular-dep workaround when these aren't).

#### `if (a) x else if (b) y` chain where a small map reads better
**Where:** `src/routes/websocket.ts:134-139`:
```ts
watchExtensions((slug, type) => {
  if (type === 'css') {
    broadcastGlobalEvent({ type: 'extension.cssChanged', data: { slug } } as SessionEvent);
  } else if (type === 'client') {
    broadcastGlobalEvent({ type: 'extension.reload', data: { slug } } as SessionEvent);
  }
});
```
**What to do:**
```ts
const EXT_EVENT: Record<string, string> = { css: 'extension.cssChanged', client: 'extension.reload' };
watchExtensions((slug, type) => {
  const ev = EXT_EVENT[type];
  if (ev) broadcastGlobalEvent({ type: ev, data: { slug } } as SessionEvent);
});
```
**Impact:** Marginal (~3 LOC) but the next extension type becomes a one-line addition.

#### `if (existsSync(a)) return a; if (existsSync(b)) return b;` chain
**Where:** `src/session-meta-store.ts:49-51`:
```ts
if (existsSync(gif)) return gif;
if (existsSync(png)) return png;
```
And the same shape in `src/applet-store.ts:122-128`:
```ts
const userPath = join(USER_APPLET_DIR, resolved, filename);
try { await stat(userPath); return userPath; } catch { /* */ }
const bundledPath = join(BUNDLED_APPLET_DIR, resolved, filename);
try { await stat(bundledPath); return bundledPath; } catch { /* */ }
return null;
```
**What to do:** For the sync case:
```ts
return [gif, png].find(existsSync);
```
For the async one, accept slightly more lines but at least extract the existence-check helper:
```ts
const exists = async (p: string) => stat(p).then(() => true, () => false);
for (const dir of [USER_APPLET_DIR, BUNDLED_APPLET_DIR]) {
  const p = join(dir, resolved, filename);
  if (await exists(p)) return p;
}
return null;
```
**Impact:** ~5 LOC, low risk. Same pattern duplicated in `resolveAppletDir` (`applet-store.ts:105-120`).

#### Redundant emptiness check on `Map.keys().next()`
**Where:** `src/sdk-session-store.ts:108-111`:
```ts
if (lastTurnsCache.size >= LAST_TURNS_CACHE_LIMIT) {
  const firstKey = lastTurnsCache.keys().next().value;
  if (firstKey !== undefined) lastTurnsCache.delete(firstKey);
}
```
The outer guard already ensures `size >= 1`, so `firstKey` cannot be `undefined`. Idiomatic:
```ts
if (lastTurnsCache.size >= LAST_TURNS_CACHE_LIMIT) {
  const [oldest] = lastTurnsCache.keys();
  lastTurnsCache.delete(oldest);
}
```
**Impact:** 2 LOC, low risk.

---

### Simplicity

#### `public/ts/event-inserter.ts` is dead code (~300 LOC)
**Where:** `public/ts/event-inserter.ts` (298 lines) and `tests/unit/event-inserter.test.ts`.
**What's wrong:** The file's siblings already make it explicit:
- `dom-regions.ts:1-11` — `"Absorbed from: element-inserter.ts, event-inserter.ts"`.
- Grep confirms zero production importers of `event-inserter`:
  ```
  $ rg "from .*event-inserter" public/ts src
  tests/unit/event-inserter.test.ts:5: ...
  ```
- The `insertEvent` / `hasInserter` exports are only used by the test that lives alongside them.
- The body is byte-identical to large sections of `dom-regions.ts` (verified by `diff`).
**What to do:** Delete `public/ts/event-inserter.ts` and `tests/unit/event-inserter.test.ts`.
**Impact:** ~400 LOC removed across module + test, deletes a category of "which one do I edit?" confusion. Risk: low — if a build references it, `tsc` will tell you immediately.

#### `ChatViewController` and `HistoryLoader` are classes-of-one with all-private state
**Where:** `public/ts/chat-view-controller.ts:29-401`; `public/ts/history-loader.ts:29-140`.
**What's wrong:** Both files end with `export const chatView = new ChatViewController()` / `historyLoader = new HistoryLoader()` — a single module-level instance whose only purpose is to namespace private fields. The class adds nothing the module can't do (`let sessionDrafts = new Map<…>()` at module scope is identical). The author has clearly noticed this pattern, since most of the codebase IS modules-of-functions (`panel-state.ts`, `applet-runtime.ts`, `app-state.ts`).
**What to do:** Convert to functions + module-private `let` state. Keep the public surface identical (still `import { chatView } from …`), but `chatView` becomes an object literal of exported functions rather than a class instance. Or migrate call sites to direct function imports — `chatView.activateSession(id)` → `activateSession(id)`.
**Impact:** ~30 LOC per file in boilerplate, removes a real coupling pattern (test mocks of `chatView` have to mock the whole singleton). Medium risk — call sites are widespread. Defer to a dedicated cleanup.

#### Duplicated startIndex loop in `readLastTurns`
**Where:** `src/sdk-session-store.ts:83-99`:
```ts
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('"user.message"')) {
    turnsFound++;
    if (turnsFound >= turns) { startIndex = i; break; }
  }
}

while (startIndex > 0 && (lines.length - startIndex) > maxEvents && turns > 3) {
  turns--;
  turnsFound = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"user.message"')) {
      turnsFound++;
      if (turnsFound >= turns) { startIndex = i; break; }
    }
  }
}
```
**What to do:** Hoist the inner loop:
```ts
function findNthUserMessageFromEnd(lines: string[], n: number): number {
  let found = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"user.message"') && ++found >= n) return i;
  }
  return 0;
}

let startIndex = findNthUserMessageFromEnd(lines, turns);
while (startIndex > 0 && (lines.length - startIndex) > maxEvents && turns > 3) {
  turns--;
  startIndex = findNthUserMessageFromEnd(lines, turns);
}
```
**Impact:** ~10 LOC, low risk.

#### `_getSessionModel` and `_evictInactiveSessions` are misleadingly named
**Where:** `src/session-manager.ts:437, 952`.
**What's wrong:** Both have a leading underscore that traditionally signals "unused" or "private internal not to be touched", but `_getSessionModel` is called from `session-manager.ts:1179` and `_evictInactiveSessions` is called normally. The underscore is just noise here.
**What to do:** Rename `getSessionModel` / `evictInactiveSessions`.
**Impact:** 2 renames, removes a misread.

#### Unused parameter `_sessionId` in `showChat`
**Where:** `public/ts/chat-view-controller.ts:270`:
```ts
private showChat(sessionId: string, cwd: string, model?: string, hasGit = false, name?: string,
  _sessionId?: string, hasIcon?: boolean, kind?: string, ...
```
The `_sessionId` is identical in purpose to `sessionId` and never used downstream. The single caller passes `data.sessionId` in both slots (`chat-view-controller.ts:142`).
**What to do:** Drop the parameter; update the one caller.
**Impact:** 1 LOC. Catches a stale signature from a refactor.

---

### Coupling

#### `SessionEvent` type defined in five places
**Where:**
- `src/types.ts:127`
- `src/session-manager.ts:383-387`
- `src/sdk-session-store.ts:19`
- `src/routes/websocket.ts:57-61`
- `public/ts/types.ts:9`

The shapes are subtly different (some have `data?: Record<string, unknown>`, some don't include the index signature, etc). Modules then `import type { SessionEvent } from './routes/websocket.js'` from places like `quota-poller.ts:20` and `dispatch-events.ts:14`, which forces non-route modules to depend on a route module.
**What to do:** Pick one canonical definition in `src/types.ts`, re-export from `routes/websocket.ts` if the route file's surface should expose it, and have `quota-poller.ts` / `dispatch-events.ts` import from `types.ts` directly. The front-end can keep its own (browser-side schema is allowed to drift from server-side), but standardize the server.
**Impact:** ~15 LOC of duplicate definitions removed; eliminates the `model → routes` upward import.

#### `QuotaSnapshot` defined three times, identically
**Where:** `src/usage-state.ts:13-19`, `src/dispatch-events.ts:16-22`, `src/quota-poller.ts:22-28`.
**What to do:** Define once (most natural home: `usage-state.ts`), import the other two sites.
**Impact:** ~15 LOC, low risk.

#### `ActiveSession` defined in `src/types.ts` is dead; `session-manager.ts` defines its own
**Where:** `src/types.ts:24-28` vs. `src/session-manager.ts:389-392`.
**What's wrong:**
```
$ rg '\bActiveSession\b' src public/ts
src/types.ts:24:export interface ActiveSession { ... }
src/session-manager.ts:389:interface ActiveSession { ... }
src/session-manager.ts:456:  private activeSessions = new Map<string, ActiveSession>();
```
No importer of the exported type — `session-manager.ts` shadows it locally.
**What to do:** Delete `ActiveSession` from `src/types.ts`. (Keeping it in `session-manager.ts` is correct — it's a session-manager implementation detail; it shouldn't be part of the public types surface.)
**Impact:** ~5 LOC removed; deletes the implication that this is a public type.

#### Server modules reach into `routes/websocket.ts` for broadcast
**Where:** `src/dispatch-events.ts:13`, `src/quota-poller.ts:19`, `src/browser-tools.ts:23`, plus several others all do:
```ts
import { broadcastGlobalEvent } from './routes/websocket.js';
import type { SessionEvent } from './routes/websocket.js';
```
**What's wrong:** Non-route, non-transport modules (a state poller, an event-effects layer, the browser-tools module) depend on a transport-layer file. The right shape is the other way around — transport subscribes to a domain event bus.
**What to do:** Extract a tiny `src/event-bus.ts` with a `broadcastGlobalEvent` that domain code imports, and have `routes/websocket.ts` subscribe to it (or simply re-bind). Even a one-line indirection (`event-bus.ts` re-exports from `routes/websocket.ts` for now) flips the dependency direction and lets the move happen later without breaking importers.
**Impact:** Medium — about 6 import sites updated. Risk: low. Architectural payoff is large; this is the only cross-layer dependency that smells across the codebase.

#### Dynamic `await import('./router.js')` to break a chat ↔ router cycle
**Where:** `public/ts/chat-view-controller.ts:233`:
```ts
const { loadApplet } = await import('./router.js');
```
`router.ts:21` already imports `{ chatView } from './chat-view-controller.js'`. The cycle is real and dynamic import is hiding it.
**What to do:** `loadApplet` only reads `getActiveSessionId()` and POSTs `/api/applets/:slug/load`; it doesn't depend on anything router-internal. Move `loadApplet` into `applet-runtime.ts` (which is where everything else applet-content-related lives), and have `router.ts` import it from there. Both `chat-view-controller.ts` and `router.ts` then import from a leaf module — the cycle dissolves.
**Impact:** ~30 LOC moved, deletes a category (the only dynamic import on the front-end). Risk: low — `loadApplet` has no router-internal coupling beyond what `pushApplet` already provides.

#### Dynamic `await import('./restart-manager.js')` in two places
**Where:** `src/applet-tools.ts:389`; `src/routes/api.ts:686`.
**What's wrong:** Same shape — looks like a deliberate circular-dep dodge.
**What to do:** Inspect; if `restart-manager` imports something that transitively imports the importer, refactor the leaf out. If not, just hoist. (Quick check: `restart-manager.ts` is 159 lines and looks self-contained — likely just lazy-loaded for startup time, which isn't justified for these call sites.)
**Impact:** Low; removes another instance of a misleading pattern.

#### `as unknown as { rpc: { ... } }` proliferating around the SDK client
**Where:** `src/session-manager.ts:485, 566, 1201, 1391, 1407, 1439`.
**What's wrong:** Six casts shaped like:
```ts
const session = active.session as unknown as { rpc: { history: { compact: () => Promise<…> } } };
```
Each call site re-declares a slice of the SDK's RPC surface. When the SDK signature drifts, every call site has to be patched independently. The `as unknown as` indicates the SDK isn't typed at the consumer boundary.
**What to do:** Declare a single `CopilotClientInstance` augmentation (or even just a `SdkRpc` interface) at the top of `session-manager.ts` that unions the RPC slices in use, and cast the client *once* on creation (`ensureClient`). Subsequent uses become typed accesses.
**Impact:** ~30 LOC, removes 5 `as unknown as` casts, gives one place to update when the SDK changes. Medium risk if SDK types are unstable — but that risk exists today, just spread across more sites.

---

### Maintainability

#### `default export` on every Express router file + the session-manager singleton
**Where:** `src/routes/*.ts` (11 files); `src/session-manager.ts:1470` (`export default sessionManager`).
**What's wrong:** The stated team preference is named exports. Default exports lose grep-ability (`grep "sessionManager\\."` works, `grep "import sessionManager"` works, but tooling renames break silently). The pattern shows up specifically where `import router from './foo.js'; app.use('/x', router)` benefits from a single default name — but `export const sessionsRouter` works just as well.
**What to do:** Convert `export default router` to `export const router` and update the small number of importers. For `sessionManager`, `export const sessionManager` and update `import sessionManager from './session-manager.js'` to `import { sessionManager }`.
**Impact:** Mechanical, ~15 LOC across the codebase. Low risk. Consider only if you're doing the renames anyway.

#### Long files past the 500-line bar
**Where:**
- `src/session-manager.ts` — 1470
- `public/ts/applet-runtime.ts` — 964
- `src/routes/sessions.ts` — 845
- `public/ts/session-panel.ts` — 756
- `public/ts/dom-regions.ts` — 728
- `src/routes/api.ts` — 698

`session-manager.ts` is the standout. It mixes: shared-client lifecycle (`ensureClient`, `proactiveHealthCheck`, `resetIdleTimer`), MCP config loading (`loadMcpServers`, `injectOAuthTokens`), session-error auto-repair (`shouldAutoRepairSessionError`), session CRUD, history queries, import/export (`exportToFile`, `archive`), eviction logic, and a half-dozen SDK RPC adapters. The MCP loaders (lines 19-89) and the auto-repair helpers (94 onward) are obvious extract candidates — they're already pure functions sitting at the top of the file as if waiting for someone to move them.
**What to do:** Extract `src/mcp-config-loader.ts` (the two MCP functions) and `src/session-auto-repair.ts` (the error-classifier + repair helpers). Don't try to break up the `SessionManager` class itself — its state is genuinely coupled.
**Impact:** ~150 LOC extracted from the 1470-line file. Low risk; functions are already pure.

#### Two `historyComplete` parameters named the same way
**Where:** `public/ts/history-loader.ts:95` — `finish` accepts `data?: { isBusy?: boolean; usage?: …  }`. Compare to the `HistoryComplete` event payload in `websocket.ts`. Inline-defined types like this make a contract that's invisible from the consumer side. Low priority, just noting.

#### Repeated `let X: ReturnType<typeof setTimeout> | null = null` + clear pattern
**Where:** `public/ts/button-gestures.ts:56`, `public/ts/model-selector.ts:121`, `public/ts/applet-runtime.ts:303`, plus the `idleTimer`/`healthTimer` in `session-manager.ts:467-468`.
**What's wrong:** Hand-rolled debounce/timer-reset boilerplate in at least 4 places. There's no debounce utility in the codebase.
**What to do:** *Don't* introduce a generic `debounce()` utility — it would add an abstraction the team has been deliberately avoiding. Just note the pattern; if a 5th instance lands, that's the trigger to extract.
**Impact:** None today. This is a "patterns to watch" item.

## 3. Patterns to repeat

- **`src/storage.ts`** — a 53-line façade re-exporting from six focused modules. The header comment explicitly describes the prior god-module. This is the right model for `session-manager.ts` if it ever grows further.
- **`src/usage-state.ts`** — module-private `let currentUsage` + a handful of pure functions. No class, no singleton ceremony. The shape every "stateful module" in the codebase should look like.
- **`src/quota-poller.ts`** — single-flight pattern (`let inFlight: Promise<void> | null`), explicit `pollQuota` and `maybePollQuota` with a clean rate-limit guard. Concise and readable.
- **`src/dispatch-events.ts`** — pure-effects-layer module with explicit `DispatchEventDeps` injection. Easy to test, no transport coupling beyond the `broadcastGlobalEvent` import (which is the layering bug noted above — but the structure is otherwise exemplary).
- **`public/ts/panel-state.ts`** — `createPanelStateStore` returning a `{ get, set, subscribe }` object. Tiny, testable, zero DOM. The `_singleton` lazy getter at the bottom is the right way to expose a module-level instance while letting tests construct their own. This is the pattern that should replace `ChatViewController` / `HistoryLoader`.

## 4. Avoid these proposals

I considered and rejected the following:

- **Introducing a `debounce()` / `throttle()` utility.** The hand-rolled timer state in `model-selector.ts`, `button-gestures.ts`, and `applet-runtime.ts` is each ~5 lines and uses different semantics (long-press, debounced sync, single-shot reset). Extracting a generic would add an abstraction layer for code that's clearer in place. Wait until a 5th call site lands.
- **Converting the route files to a typed `defineRoute` framework.** The routes already use Express idiomatically; replacing `router.get('/foo', handler)` with a "typed route builder" would add ceremony with no payoff. The duplication that exists (e.g. `if (!sessionId) res.status(400)…`) is one-liner-thin and doesn't justify an abstraction.
- **Replacing the `as unknown as { navigation?: Navigation }` casts with a `polyfill-navigation.ts` shim.** A single-cast `(window as { navigation?: Navigation }).navigation` (or a `declare global { Window }` augmentation) covers it. A polyfill module would be overkill — three sites is the whole exposure.
- **Generic `SDKEvent` Zod schema.** The various `SessionEvent` definitions are intentionally loose (`[key: string]: unknown`) to forward arbitrary SDK events through. Tightening with Zod would force re-validation at every hop with no benefit; the boundary between Caco and the SDK is a forwarding pipe, not a parsing boundary.
- **Pulling `dom-regions.ts` into smaller sub-modules.** The 728-line size looks scary, but the file is a single coherent concept (scoped region access + ChatRegion mutations) and is the *result* of a successful consolidation from three smaller files. Splitting again would re-introduce the cross-module DOM-query problem the consolidation fixed. Leave it.
- **Replacing `for (let i = lines.length - 1; i >= 0; i--)` with `.reverse().findIndex(…)`.** The reverse-array allocation would dwarf the loop cost on multi-thousand-line `events.jsonl` files. The C-style loop is actually idiomatic here. (Most of the other `for (let i …)` instances in the grep are similarly index-essential.)
