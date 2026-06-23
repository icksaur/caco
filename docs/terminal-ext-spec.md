# Spec: terminal extension (node-pty + xterm.js) — V1 spike

## Goal

A real, user-identity terminal you can pop open under the meta-context footer — **pwsh on
Windows, a TTY shell on Linux** — with the terminal *feature* (panel, glyph, pty bridge)
living entirely in a vendored Caco **extension** (`~/.caco/extensions/terminal/`). A small
glyph mid-right in the footer toggles a panel that takes vertical space **below** the footer.
The pty is a **child of the Caco session**: one terminal per session; switching sessions
switches terminals.

**Honest reframe (post-review):** a *zero-core* V1 is NOT achievable for the exact
session-child semantics — the current extension API lacks the seams (session-scoped client
events, active-session id, session cwd, a real footer right-slot, server-known session
context on inbound messages). So V1 = **(a) a small set of GENERIC, reusable extension-API
seams in core** + **(b) the terminal as a vendored extension on top.** The terminal UI/logic
never enters core; only generic plumbing does. Deleting the extension dir removes the
*feature*; the seams remain as capability for any future extension. This split is the
reviewer's recommended path (B): land the seams first, then the extension.

V1 is a spike on branch `terminal-ext`.

## Part A — generic extension-API seams to add to core (V1 prerequisite)

Each is small, generic, and independently useful — none is terminal-specific.

| Seam | Where | Why |
|---|---|---|
| `ext.<slug>.*` message namespacing already required | `src/routes/websocket.ts` (dispatch only fires `onClientMessage` for `msg.type.startsWith('ext.')`) | protocol must use `ext.terminal.*` — not a change, a constraint to honor |
| **server-known session context** on inbound: `onClientMessage(type, (ws, data, ctx) => …)` where `ctx.sessionId` is the ws's *subscribed* session (from the websocket layer's private subscription map) | `src/extension-runtime.ts` + `src/routes/websocket.ts` | removes client-stamped `sid` spoofing; authorizes input to the ws's own session |
| **session-scoped client events**: `api.onSessionEvent((sid, event) => …)` (or preserve `sessionId` in the extension event callback) | `public/ts/extension-api.ts` (currently `on` only sees global events, `sessionId` stripped) | so the client can route `term:output` to the right xterm |
| **active session id + change**: `api.getActiveSessionId()` + `api.onActiveSessionChange(cb)` | `public/ts/extension-api.ts` (wrap `app-state.getActiveSessionId`/`setActiveSession` listeners) | client can stamp attach, swap visible terminal |
| **read-only session info**: `api.getSessionInfo(sid) -> { cwd }` | `src/extension-runtime.ts` (read session meta) | spawn the pty in the session's cwd — the "child of the session" cwd |
| **a real footer right-slot**: ensure `footer.addRight` mounts into an existing element (add a `.context-status`/right container to `#contextFooter`, or repoint `addRight`) | `public/index.html` + `public/ts/extension-api.ts` (`addRight` queries `.context-status` which does not exist → no-op today) | the toggle glyph must actually mount |
| **same-origin WS check** before honoring `ext.*` input | `src/routes/websocket.ts` (no `Origin` validation today) | a real shell-input channel needs origin/session authorization, not just CSP |

These seams are the BLOCKING items from review, generalized. They make the extension system
capable of *any* session-bound, server-backed panel — the terminal is just the first user.

## Part B — the terminal extension (vendored)

### Server (`server.ts`)
- `ptys: Map<sessionId, { pty: IPty; buf: RingBuffer }>`.
- **Shell selection** (self-contained copy of the pure logic in `src/workflow/shell.ts`):
  win32 → `pwsh`/`powershell` (PATH lookup); else PATH `bash` → `sh` fallback. **Interactive
  PTY: pass NO `-c` flags** (unlike the workflow's command-exec use).
- **Lazy spawn** on `ext.terminal.attach`: `pty.spawn(shell, [], { name:'xterm-color', cols,
  rows, cwd: api.getSessionInfo(ctx.sessionId)?.cwd ?? process.cwd(), env: process.env })` —
  runs as the Caco server's (i.e. the user's) identity.
- `pty.onData(d => { ring.push(sid,d); api.broadcastToSession(sid,'ext.terminal.output',{sid,data:d}); })`.
- Handlers (all use `ctx.sessionId`, NOT client-supplied sid):
  - `ext.terminal.attach (ctx,{cols,rows}) → ensurePty; replay bounded scrollback`
  - `ext.terminal.input  (ctx,{data})      → pty.write(data)`
  - `ext.terminal.resize (ctx,{cols,rows}) → pty.resize`
  - `ext.terminal.close  (ctx)             → pty.kill (process-group), drop`
- **Bounded scrollback ring** per session (e.g. 256 KB) so background output (when a session
  has no subscriber, `broadcastEvent` drops) is replayed on re-attach. Output **coalesced**
  (batch within a frame / max chunk) for throughput.
- Static assets: `router.use(express.static(<ext>/web))` → client imports `@xterm` from
  `/ext/terminal/...` (confirmed feasible; same-origin, CSP-allowed).

### Client (`client.ts` + `style.css`)
- Dynamic-import vendored `@xterm/xterm` + `@xterm/addon-fit` from `/ext/terminal/`.
- `terms: Map<sid, { term, fit, el }>`; only the active session's `el` visible.
- Glyph via `footer.addRight('term-toggle', …)` (needs Part A footer slot) → toggle panel.
- Panel `div.terminal-panel` inserted as **last child of `#chatFooter`** (renders below
  `#contextFooter`; `.chat-scroll` is `flex:1` so it shrinks). **CSS contract:**
  `align-self:stretch; width:100%`, fixed ~280px tall in V1, dark, monospace
  (`#chatFooter` is `align-items:center`, so stretch/width are required).
- On open for the active session: lazily create xterm, fit, `send('ext.terminal.attach',{cols,rows})`,
  wire `term.onData(d => send('ext.terminal.input',{data:d}))`.
- `api.onSessionEvent((sid,e)=>{ if(e.type==='ext.terminal.output') terms.get(sid)?.term.write(e.data.data) })`.
- `api.onActiveSessionChange(sid => swap visible terminal el)`; background terms stay alive.
- Fit + `ext.terminal.resize` on open and window resize.

### Message protocol (client ↔ extension, over Caco's existing `/ws`)
```
client → server:  ext.terminal.attach  { cols, rows }          (sid from ctx)
client → server:  ext.terminal.input   { data }                (sid from ctx)
client → server:  ext.terminal.resize  { cols, rows }          (sid from ctx)
client → server:  ext.terminal.close   {}                      (sid from ctx)
server → client:  ext.terminal.output  { sid, data }           (session-scoped + replay)
```
No new ws server, no http upgrade — rides `onClientMessage`/`broadcastToSession`.

## Session coupling & lifetime

- **One pty per `sessionId`** (server, keyed by the ws-subscribed session), spawned on first
  attach in the session's cwd.
- **Switching sessions** swaps the visible xterm client-side; background ptys keep running,
  their output captured in the per-session ring buffer and replayed on re-attach.
- **Lifetime caps (V1 — no `onSessionEnd` extension hook yet; core has an internal
  `sessionState.onSessionEnd` that V2 should expose):**
  - explicit close glyph → kill;
  - **max PTY count** (e.g. 8) — evict the least-recently-attached;
  - **max detached lifetime** (killed N min after its last client detaches, regardless of
    output — so a runaway command can't live forever);
  - bounded ring buffer (drop oldest);
  - process-**group** kill on teardown; server restart clears all.
- **V2:** expose `onSessionEnd(sid)` on `ServerExtensionAPI` for exact child-of-session
  binding. V1 approximates with the caps above and states the gap.

## Deps to vendor (into the extension dir)

- **node-pty** (server, native) — **the gating viability risk.** `npm view node-pty` shows
  `install: node scripts/prebuild.js || node-gyp rebuild`, so a prebuild is NOT guaranteed for
  Node v26.2.0. **Gate 1 of the spike:** from `~/.caco/extensions/terminal/`, `npm i node-pty`
  and `jiti.import` a trivial `server.ts` that `require('node-pty')` **inside Caco's actual
  server process**; if it falls back to `node-gyp` (needs Python + compiler), record the
  toolchain or stop. (jiti does not forbid native `.node` addons; the risk is build/resolution,
  not the loader.)
- **@xterm/xterm** + **@xterm/addon-fit** (client, pure JS — the deprecated `xterm`/
  `xterm-addon-fit` names are replaced by these scoped packages) — vendored as static ESM
  assets under `<ext>/web/`, served by the extension router.

## Considerations / risks

- **The zero-core promise is reframed, not kept.** V1 needs the Part-A seams in core. They are
  generic and reusable; the terminal feature stays in the extension. Do not claim both
  zero-core AND exact session-child semantics — they are mutually exclusive given today's API.
- **Inbound authorization.** Input is honored only for the ws's *server-known* subscribed
  session (`ctx.sessionId`), never a client-stamped sid → no cross-session shell injection.
  Add the same-origin WS check before any `ext.*` input is honored.
- **Background output** is preserved by the per-session ring buffer + replay-on-attach, not by
  live streaming to unsubscribed sessions (`broadcastEvent` drops those). Bounded to cap memory.
- **JSON-over-WS throughput.** PTY data is string-oriented; control sequences ride fine in
  JSON. Specify: output coalescing, max chunk size, paste chunking, a `bufferedAmount`
  high-water backpressure check, ring-buffer cap. Binary/base64 unnecessary unless a concrete
  encoding bug appears.
- **Security.** A real shell as the user is a direct command channel — stronger than the
  existing agent-mediated workflow RCE. Mitigate with: server-known `ctx.sessionId` (no
  spoofing), same-origin WS validation, localhost-only (no new port), no cross-origin `/ext`
  ws. This is a real new surface; the seam work must include the origin check.
- **Resize correctness.** Fit on open + window resize; always `ext.terminal.resize` after fit.

## V1 scope vs non-goals

**In V1:** the Part-A seams; single active-session terminal with background ptys + ring-buffer
replay; footer glyph + `Ctrl+\`` toggle; panel below footer (fixed height); input/output/
resize; pwsh-Windows / shell-Linux; lifetime caps (count, detached-TTL, ring); monospace +
Caco-tuned theme.

**Not in V1:** live streaming to *unsubscribed* sessions (replay only); the `onSessionEnd`
core hook (exact lifetime binding); drag-to-resize; scrollback persistence across restart;
split panes; copy/paste toolbar; per-session env customization.

## Acceptance (spike)

- **Gate 1 (viability):** `npm i node-pty` in the extension dir resolves and `require`s under
  Caco's server process on Node v26.2.0 Linux; record prebuild vs node-gyp. **If node-gyp with
  no toolchain → stop/redecide before further work.**
- Part-A seams land with unit coverage where testable (message-context resolution,
  active-session accessor, footer right-slot mounts, session-scoped event delivery preserves
  `sid`, same-origin WS rejection).
- Opening the glyph spawns a shell as the user in the **session's cwd**;
  `mkdir -p .caco-terminal-probe && touch .caco-terminal-probe/ok && ls .caco-terminal-probe`
  works and renders (scratch path under the session cwd — **not** `/tmp`).
- pwsh launches on Windows, PATH `bash`→`sh` on Linux (Windows validated manually if no host).
- Switch session and back: the active terminal is correct and isolated; a background pty's
  output is replayed on re-attach (not lost).
- Closing the glyph hides the panel; the pty survives until a cap fires; an inbound message
  with a forged sid does not reach another session's pty.
- The terminal *feature* is fully contained in `~/.caco/extensions/terminal/` (only the generic
  Part-A seams live in core).

## Plan (ordered, on branch `terminal-ext`)

1. **Gate 1: prove node-pty** under Caco's server process on Node 26 (install + jiti import +
   require). Go/no-go.
2. **Part-A core seams** (generic): `ctx.sessionId` on `onClientMessage`; `onSessionEvent`/
   sid-preserving event delivery; client `getActiveSessionId`+`onActiveSessionChange`;
   `getSessionInfo(sid).cwd`; footer right-slot; same-origin WS check. Unit-test each.
3. **Server pty bridge** (`server.ts`): shell select, lazy spawn in session cwd, 4 handlers via
   `ctx.sessionId`, ring buffer + replay, lifetime caps, process-group kill.
4. **Client panel** (`client.ts`+`style.css`): vendored @xterm under `<ext>/web/`, glyph,
   panel-below-footer CSS contract, attach/input/output/resize, active-session swap.
5. **Validate** against acceptance (Linux now; Windows/pwsh as available).
6. **Decide V2**: expose `onSessionEnd` for exact lifetime binding + live background streaming,
   based on what V1 confirms.

V1 = generic seams + a vendored, session-scoped terminal extension. Exact child-of-session
lifetime (`onSessionEnd`) and live multi-session streaming are V2.
