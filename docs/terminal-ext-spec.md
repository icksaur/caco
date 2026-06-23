# Spec: integrated terminal (node-pty + xterm.js) — V1, core feature

## Goal

A real, user-identity terminal under the meta-context footer — **pwsh on Windows, a TTY
shell on Linux** — built as a **first-class core feature** (not an extension). A small glyph
mid-right in the footer toggles a panel that takes vertical space **below** the footer. The
pty is a true **child of the Caco session**: one terminal per session, bound to the session's
lifetime; switching sessions switches terminals.

**Why core, not an extension (decided):** the extension boundary forced workarounds — TTL
reaping instead of real lifetime, client sid-stamping, ring-buffer replay to dodge event
delivery, a duplicate shell resolver, static-served xterm, a no-op footer slot. Core has
first-class access to session lifecycle, the ws↔session subscription, session cwd, the build
pipeline, and the DOM — every workaround disappears. node-pty viability on Node 26 is
**confirmed** (Gate 1: loads + spawns; Linux compiles via the present toolchain, Windows/macOS
ship prebuilt binaries).

V1 on branch `terminal-ext`.

## Architecture

### Server — `src/terminal-manager.ts` (new)
- `terminals: Map<sessionId, { pty: IPty; ring: RingBuffer }>`.
- **Shell:** reuse `resolveShell()` from `src/workflow/shell.ts` directly, but spawn it
  **interactively** — no `-c`/`-Command` flags (those are for the workflow's command-exec use).
  win32 → pwsh/powershell; else bash→sh (PATH-resolved). Verify the interactive-launch arg
  difference (e.g. pwsh `-NoLogo`, bash login/interactive) in the spike.
- **Lazy spawn** on first attach for a session: `pty.spawn(shell, args, { name:'xterm-color',
  cols, rows, cwd: <session cwd from session state>, env: process.env })` — runs as the Caco
  server's (the user's) identity.
- `pty.onData(d => { ring.push(d); broadcastEvent(sid, { type:'caco.term.output', data:{ data:d } }); })`
  — reuses the existing per-session broadcast (output is delivered to that session's ws only).
- **Lifetime = session lifetime.** Subscribe to `sessionState.onSessionEnd(sid)` (the
  internal hook that already exists in core) → `pty.kill()` (process-group) + drop. This is
  the exact child-of-session guarantee the extension path could not give. Also: explicit
  close, a max-terminal cap (evict LRU) as a safety bound, and process-restart clears all.
- Bounded scrollback **ring** (e.g. 256 KB) per session, **replayed on attach** so switching
  back to a session restores its terminal view.

### WebSocket — extend the existing dispatch (`src/routes/websocket.ts`)
- Add inbound types handled where the ws's **subscribed session is already known** (the ws
  layer holds the subscription map) — so no client-supplied sid, no spoofing, native scoping:
  - `caco.term.attach { cols, rows }` → `ensureTerminal(sid, cwd, cols, rows)`; replay ring.
  - `caco.term.input  { data }`        → `pty.write`.
  - `caco.term.resize { cols, rows }`  → `pty.resize`.
  - `caco.term.close  {}`              → kill + drop.
- **Same-origin WS check** (new, required): the ws server does not validate `Origin` today; a
  real shell-input channel must reject cross-origin connections before honoring `caco.term.*`.
  Localhost-only; no new port (rides existing `/ws`).
- Outbound `caco.term.output` flows through the existing `broadcastEvent`; **history/replay**
  intentionally does NOT persist terminal output (live + ring only) — filter it in the
  event-persistence path like other ephemerals.

### Client — `public/ts/terminal-panel.ts` (new) + `style.css`
- `@xterm/xterm` + `@xterm/addon-fit` as **npm deps, bundled via the existing esbuild**
  pipeline (`build:client`) — no static serving.
- `terms: Map<sessionId, { term, fit, el }>`; only the active session's element visible.
- **Glyph** mid-right in `#contextFooter` (own DOM, no extension slot needed); `Ctrl+\``
  toggles; click toggles.
- **Panel** `div.terminal-panel` as the last child of `#chatFooter` → renders below
  `#contextFooter`; `.chat-scroll` is `flex:1` so it shrinks. CSS contract:
  `align-self:stretch; width:100%` (`#chatFooter` is `align-items:center`), fixed ~280px in
  V1, dark, monospace.
- Uses `app-state.getActiveSessionId()` + the active-session-change path directly to swap the
  visible terminal; background terms stay alive.
- On open: create xterm, fit, send `caco.term.attach`; `term.onData → caco.term.input`;
  receive `caco.term.output → term.write`; fit + `caco.term.resize` on open/window-resize.

### Message protocol (over existing `/ws`)
```
client → server:  caco.term.attach { cols, rows }
client → server:  caco.term.input  { data }
client → server:  caco.term.resize { cols, rows }
client → server:  caco.term.close  {}
server → client:  caco.term.output { data }     (session-scoped; ring-replayed on attach)
```

## Session coupling & lifetime

- **One pty per session**, spawned lazily in the session's cwd, **killed on `onSessionEnd`** —
  exact child-of-session binding (the core win).
- Switching sessions swaps the visible xterm; background ptys keep running, output captured in
  the ring and replayed on re-attach.
- Safety bounds: process-group kill on teardown, max-terminal cap (LRU evict), bounded ring,
  restart clears all.

## Layout / UX

- Glyph: small monospace `>_` mid-right in `#contextFooter`, accent when open.
- Panel below the footer, ~280px (drag-resize is V2), full width, dark, monospace; chat scroll
  shrinks to fit. `Ctrl+\`` toggles; focus enters the terminal on open.

## Dependencies

- **node-pty** (server, native) — viability confirmed on Node 26 (Gate 1). Note for the repo
  install: npm's `allow-scripts` policy warns on node-pty's build script; the Linux build still
  produced `build/Release/pty.node` and loaded. Ensure `npm install` builds it in the real repo
  (toolchain present); Windows/macOS use shipped prebuilds.
- **@xterm/xterm**, **@xterm/addon-fit** (client, pure JS) — bundled via esbuild (the scoped
  packages; the unscoped `xterm`/`xterm-addon-fit` are deprecated).

## Considerations / risks

- **Real shell = direct command channel.** Stronger than the existing agent-mediated workflow
  RCE. Mitigate: server-known subscribed session (no client sid), **same-origin WS check**
  (new), localhost-only, terminal output excluded from persisted history.
- **node-pty in the bundle/build.** It's a server dep (not bundled — server runs via tsx).
  Confirm the repo `npm install` compiles it under the allow-scripts policy; if the policy
  blocks it in a clean CI/install, add the approve-scripts/config so the build runs.
- **JSON-over-WS throughput.** PTY data is string-oriented; control sequences ride fine.
  Specify output coalescing (batch within a frame), max chunk size, paste chunking, a
  `bufferedAmount` backpressure check, ring cap. Binary/base64 not needed for V1.
- **Interactive shell args.** Don't reuse the workflow's `-c`/`-Command` exec flags; launch an
  interactive shell. Verify per-shell (pwsh `-NoLogo -NoExit`? bash interactive) in the spike.
- **Resize correctness.** Fit on open + window resize; always `caco.term.resize` after fit so
  the pty winsize matches.
- **History/replay.** Terminal output is live+ring only, never persisted to session history;
  filter `caco.term.*` in the persistence path (like other ephemeral events).

## V1 scope vs non-goals

**In V1:** core terminal manager; one pty per session bound to `onSessionEnd`; footer glyph +
`Ctrl+\`` toggle; panel below footer (fixed height); attach/input/output/resize; ring replay
on session switch; pwsh-Windows / shell-Linux; same-origin WS check; safety caps; monospace +
Caco-tuned theme; @xterm bundled.

**Not in V1:** drag-to-resize; scrollback persistence across restart; split panes; copy/paste
toolbar; per-session env customization; multiple terminals per session; mobile layout.

## Acceptance

- node-pty builds + loads in the repo install on Node 26 (Gate 1 met in isolation; re-confirm
  as a real dependency under the allow-scripts policy).
- Opening the glyph spawns a shell as the user in the **session's cwd**;
  `mkdir -p .caco-terminal-probe && touch .caco-terminal-probe/ok && ls .caco-terminal-probe`
  renders (scratch under session cwd — **not** `/tmp`).
- pwsh on Windows, PATH bash→sh on Linux (Windows validated manually if no host).
- The pty is **killed when the session ends** (`onSessionEnd`) — assert no orphaned process.
- Switch session and back: the active terminal is correct and isolated; the prior session's
  terminal view is **ring-replayed** on return.
- A cross-origin ws connection is rejected before any `caco.term.input` is honored.
- Terminal output does **not** appear in persisted session history.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered, branch `terminal-ext`)

1. **Dep:** add node-pty + @xterm/xterm + @xterm/addon-fit; confirm node-pty builds in the repo
   install (allow-scripts) and `build:client` bundles xterm.
2. **`terminal-manager.ts`:** map, `resolveShell` interactive spawn in session cwd, ring buffer,
   `onSessionEnd` kill, process-group teardown, caps. Unit-test lifecycle + ring.
3. **WS wiring:** `caco.term.*` inbound handlers keyed by the ws's subscribed session;
   same-origin check; exclude `caco.term.output` from persisted history. Unit-test origin
   rejection + session scoping.
4. **Client `terminal-panel.ts` + CSS:** bundled xterm, footer glyph, panel-below-footer
   contract, attach/input/output/resize, active-session swap.
5. **Validate** acceptance (Linux now; Windows/pwsh as available); visual signoff.
6. **V2 later:** drag-resize, persisted scrollback, multi-terminal, mobile.

V1 = a core, session-bound integrated terminal: node-pty per session killed on session end,
xterm panel below the footer, pwsh/TTY per platform, same-origin-guarded over the existing ws.
