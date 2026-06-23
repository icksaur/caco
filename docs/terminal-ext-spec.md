# Spec: terminal extension (node-pty + xterm.js) — V1 spike

## Goal

A real, user-identity terminal you can pop open under the meta-context footer — **pwsh on
Windows, a TTY shell on Linux** — vendored entirely as a Caco **extension**, so it never
becomes permanent core UI. A small glyph mid-right in the footer toggles a terminal panel
that takes vertical space **below** the footer. The pty is a **child of the Caco session**:
one terminal per session, switching sessions switches terminals.

V1 is a spike on a new branch (`terminal-ext`). Self-contained in
`~/.caco/extensions/terminal/`; deleting the dir removes it with zero core residue.

## Why an extension (the seams already exist)

| Need | Extension API (verified) |
|---|---|
| PTY bytes both ways | server `onClientMessage('term:input'|'term:resize', (ws,data)=>…)` + `broadcastToSession(sid,'term:output',…)` — rides Caco's existing WebSocket; **no new ws server / no http upgrade** |
| Serve xterm assets | server `router` mounted at `/ext/terminal` (static files) |
| Footer glyph | client `footer.addRight(id, render)` |
| Terminal panel | client creates its own DOM, appended below `#contextFooter` |
| Receive output / send input | client `on('term:output', …)` (session-scoped delivery) + `send('term:input', …)` |
| Toggle shortcut | client `registerShortcut('Ctrl+\\`', …)` + `registerCommand` |
| Persist panel open/height | client + server `getState`/`setState` |

`broadcastToSession`/`broadcastEvent` deliver only to clients subscribed to that session, so
output is **naturally session-scoped** — the core of the "child of the session" coupling.

## Architecture

### Server (`server.ts`)
- Keep `ptys: Map<sessionId, IPty>` (node-pty instances).
- **Shell selection:** `process.platform === 'win32'` → `pwsh.exe` (fallback `powershell.exe`);
  else `process.env.SHELL || 'bash'`. (Mirrors `src/workflow/shell.ts`; the extension keeps a
  tiny self-contained copy rather than importing core, to stay vendor-portable.)
- **Spawn lazily** on the first `term:input`/`term:attach` for a session (don't spawn a pty
  for sessions whose terminal is never opened). `pty.spawn(shell, [], { name:'xterm-color',
  cols, rows, cwd: <session cwd>, env: process.env })` — runs as the **Caco server's user
  identity** (which is the user's, for a local personal tool).
- `pty.onData(d => api.broadcastToSession(sid, 'term:output', d))`.
- `onClientMessage('term:input', (ws,{sid,data}) => ptys.get(sid)?.write(data))`.
- `onClientMessage('term:resize', (ws,{sid,cols,rows}) => ptys.get(sid)?.resize(cols,rows))`.
- `onClientMessage('term:attach', (ws,{sid,cols,rows}) => ensurePty(sid,cols,rows))`.
- Static: `router.use(express.static(<ext>/web))` so the client can import xterm from
  `/ext/terminal/...`.
- **Message shape carries `sid`** because `onClientMessage` hands the handler `(ws, data)`,
  not a sessionId — the client stamps the active session id into every message.

### Client (`client.ts`)
- Dynamic-import vendored `xterm` + `xterm-addon-fit` from `/ext/terminal/`.
- `terms: Map<sessionId, { term: Terminal; fit: FitAddon; el: HTMLElement }>` — one xterm per
  session; only the active session's element is visible (rest `display:none`).
- Footer glyph via `footer.addRight('term-toggle', …)` → toggles the panel.
- Panel: a `div.terminal-panel` inserted as the **last child of `#chatFooter`** (so it sits
  visually below `#contextFooter` and grows upward, pushing the footer up). Height persisted
  via `setState`; a top drag-handle resizes (V2 — V1 fixed height ~280px).
- On toggle-open for the active session: lazily create its xterm, `send('term:attach',{sid,cols,rows})`,
  wire `term.onData(d => send('term:input',{sid,data:d}))` and `on('term:output', …)` →
  write to the matching session's term (match by the event's session scoping; if the API
  doesn't tag the event with sid, the client maps via the currently-attached set — see Risks).
- On active-session change (poll `getActiveSessionId()` / `on('session…')`): swap which
  term element is visible; keep the others alive and buffered.
- Monospace, xterm default dark theme tuned to Caco's footer palette via `customStyle`.

### Message protocol (client ↔ extension, over Caco ws)
```
client → server:  term:attach  { sid, cols, rows }
client → server:  term:input   { sid, data }
client → server:  term:resize  { sid, cols, rows }
server → client:  term:output  <string>          (delivered session-scoped)
```

## Session coupling & lifetime

- **One pty per `sessionId`**, spawned on first attach.
- **Switching sessions** (clicking another session) swaps the visible xterm client-side; the
  background ptys keep running and buffering. Reopening shows the session's live terminal.
- **Reaping (V1 pragmatic — the extension API has no session-end hook yet):**
  - explicit close glyph → `term:close {sid}` → `pty.kill()` + drop from map;
  - **idle TTL**: a pty with no client attached and no IO for N minutes (e.g. 30) is killed;
  - server restart clears all (process-bound).
- **V2:** add an `onSessionEnd(sid)` hook to `ServerExtensionAPI` so pty lifetime binds
  exactly to the Caco session connection (the literal "child of the session" guarantee).
  V1 approximates it with the TTL + explicit close; note the gap honestly.

## Layout / UX

- **Glyph:** small monospace `▢`/`>_` mid-right in `#contextFooter` (via `footer.addRight`);
  click toggles. Active state styled (e.g. accent when open).
- **Panel:** appears **below** the footer (last child of `#chatFooter`), fixed ~280px tall in
  V1, full footer width, dark, monospace. The chat scroll area shrinks to accommodate (flex
  layout already shrinks `#chatScroll`).
- Keyboard: `Ctrl+\`` toggles; focus moves into the terminal on open.

## Deps to vendor (into the extension dir)

- **node-pty** (server, native) — the one native dep. Ships prebuilds; **verify a Node-26 ABI
  prebuild exists** before building, else it needs `node-gyp` (Python + a compiler). This is
  the primary build risk and the first thing the spike must confirm.
- **xterm** + **xterm-addon-fit** (client, pure JS) — vendored as static assets under
  `<ext>/web/`, served by the extension router.

## Considerations / risks

- **Output routing on the client.** `broadcastToSession` is session-scoped on the wire, but
  the client `on('term:output')` handler must still route bytes to the *right* xterm when
  multiple session terminals exist. If the delivered event isn't tagged with `sid`, the client
  can only know "this is for the session I'm subscribed to" — which for a single active ws is
  the active session. **V1 constraint: render/stream only the active session's terminal**;
  background sessions' ptys keep running but their output is drained/buffered server-side and
  replayed on re-attach (send a `term:attach` that returns recent scrollback, or simply rely
  on the live shell state). Confirm the multi-session delivery semantics in the spike; if the
  event carries `sid`, full background streaming is trivial.
- **Native module.** node-pty is the only thing that can fail to install on a fresh
  platform/Node. The spike must prove `npm i node-pty` resolves a prebuild for the dev Node
  (26) on Linux first; Windows/pwsh validated separately.
- **Security.** A real shell as the user = full RCE — but Caco already auto-approves arbitrary
  code via `caco_run_workflow` and is local/personal, so this adds **no new exposure**. The pty
  binds to no network port (rides the existing localhost ws). Don't expose `/ext/terminal` ws
  cross-origin.
- **No core changes in V1.** Everything lives in the extension dir. The only *desirable* core
  addition (deferred to V2) is the `onSessionEnd` hook for exact lifetime coupling.
- **Resize correctness.** Fit addon on panel open + on window resize + on panel drag (V2);
  always `term:resize` after fit so the pty's winsize matches.

## V1 scope vs non-goals

**In V1:** single active-session terminal, lazy pty spawn, footer glyph + `Ctrl+\`` toggle,
panel below footer (fixed height), input/output/resize, pwsh-Windows / shell-Linux, idle-TTL +
explicit-close reaping, monospace + Caco-tuned theme.

**Not in V1:** background multi-session live streaming (needs confirmed sid-tagged delivery or
the V2 hook), drag-to-resize, scrollback persistence across restart, split panes, copy-paste
toolbar, per-session env customization, the `onSessionEnd` core hook.

## Acceptance (spike)

- `npm i node-pty xterm xterm-addon-fit` in the extension resolves (node-pty prebuild for
  Node 26 on Linux); record the result.
- Opening the glyph spawns a shell as the user; `touch /tmp/caco-term-test && ls` works and
  renders.
- pwsh launches on Windows, `$SHELL`/bash on Linux (verify the platform branch; Windows may be
  validated manually if no Windows host is available — note it).
- Switching to another session and back shows a terminal scoped to each (at minimum the active
  one is correct and isolated).
- Closing the glyph hides the panel; the pty survives until idle-TTL/explicit close.
- No core Caco files modified; removing `~/.caco/extensions/terminal/` fully removes the feature.

## Plan (ordered, on branch `terminal-ext`)

1. **Prove the native dep:** scaffold `~/.caco/extensions/terminal/`, `npm i node-pty`,
   confirm a Node-26 Linux prebuild (the gating risk). If it needs a build, decide go/no-go.
2. **Server pty bridge** (`server.ts`): shell select, lazy spawn map, the 4 message handlers,
   static router for xterm assets, idle-TTL reaper.
3. **Client panel** (`client.ts` + `style.css`): vendored xterm under `<ext>/web/`, footer
   glyph, panel below footer, attach/input/output/resize, active-session swap.
4. **Manual validation** against the acceptance list (Linux now; Windows/pwsh as available).
5. **Write up** the multi-session delivery finding (sid-tagged or not) to decide the V2 path
   (background streaming vs the `onSessionEnd` core hook).

V1 proves the vendored node-pty + xterm terminal as a session-scoped extension with zero core
changes; the exact session-lifetime hook and background multi-terminal streaming are V2,
gated on what the spike learns about ws delivery semantics.
