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
- Session cwd via `sessionManager.getSessionCwd(sid)` (`src/session-manager.ts:1167`); reject
  attach if null. `broadcastEvent` imported from `src/event-bus.ts`.
- `terminals: Map<sessionId, { pty: IPty; ring: RingBuffer }>`.
- **Shell:** reuse `resolveShell()` from `src/workflow/shell.ts` directly, but spawn it
  **interactively** — no `-c`/`-Command` flags (those are for the workflow's command-exec use).
  win32 → pwsh/powershell; else bash→sh (PATH-resolved). Use the resolved `file` + `dialect`,
  but **interactive args, not exec flags**: PowerShell `-NoLogo` (optionally `-NoProfile`) —
  NOT `-NonInteractive`/`-Command`/`-NoExit`; bash/sh no args (or `-i`).
- **Lazy spawn** on first attach for a session: `pty.spawn(shell, args, { name:'xterm-color',
  cols, rows, cwd: <session cwd from session state>, env: process.env })` — runs as the Caco
  server's (the user's) identity.
- `pty.onData(d => { ring.push(d); broadcastEvent(sid, { type:'caco.term.output', data:{ data:d } }); })`
  — reuses the existing per-session broadcast (output is delivered to that session's ws only).
- **Lifetime = session lifetime.** `sessionState.onSessionEnd(cb)` exists
  (`src/session-state.ts:259`): a **global** listener on the `sessionState` singleton that
  fires with the deleted `sid` on session **delete** (filter internally). On it →
  `pty.kill()` (process-group) + drop. (Eviction/newChat do NOT delete a resumable session, so
  its pty correctly survives.) Kill ALSO on: explicit `caco.term.kill`, max-terminal cap (LRU
  evict), pty self-exit, process exit. Panel close / tab close = **detach only** (count
  drops), never kill. **Do not own SIGINT/SIGTERM in the terminal manager** — that would
  suppress the server's graceful-shutdown path; register only a non-suppressing `exit` hook,
  which fires when the server's SIGINT handler calls `process.exit`.
- **Output ring holds only already-broadcast bytes** (push to the ring on flush, not on raw
  pty data). An attach snapshot then never overlaps with output still queued for the 16 ms
  coalesce flush, so a re-attach during active output cannot double-render; un-flushed bytes
  arrive next via the normal live broadcast. The client **resets the xterm before every
  (re-)attach** so the ring replay is an exact reconstruction (no backlog duplication on
  reopen). Re-attach also **resizes the existing pty** to the client's fitted cols/rows so the
  winsize never goes stale across session-swap/reconnect.
- Bounded scrollback **ring** (e.g. 256 KB) per session, **replayed on attach** so switching
  back to a session restores its terminal view.

### WebSocket — extend the existing dispatch (`src/routes/websocket.ts`)
- Resolve the ws's session via `clientSubscription.get(ws)` (the ws layer's existing
  `Map<WebSocket,string>`); reject if absent. No client-supplied sid → no spoofing. Add
  `caco.term.*` to the `ClientMessage.type` union + the `switch(msg.type)` in `handleMessage()`
  (core cases, beside the existing `ext.*` extension route). Output uses `broadcastEvent`
  imported from `src/event-bus.ts` (domain layer), not reached out of routes.
- Inbound types (session from `clientSubscription`, never the payload):
  - `caco.term.attach { cols, rows }` → `ensureTerminal(sid, cwd, cols, rows)`; replay ring.
  - `caco.term.input  { data }`        → `pty.write`.
  - `caco.term.resize { cols, rows }`  → `pty.resize`.
  - `caco.term.detach {}`              → decrement attach count (keep pty).
  - `caco.term.kill   {}`              → kill (process-group) + drop.
- **Same-origin + local-host WS guard** (new, required). Reject the ws upgrade in
  `verifyClient` unless `new URL(origin).host === req.headers.host` AND the Host header's
  hostname is in a local allowlist (`localhost`, `127.0.0.1`, `[::1]`, the configured
  `SERVER_URL` host, `os.hostname()`). Same-origin alone is insufficient — a DNS-rebinding
  page presents matching Origin/Host for its own domain after rebinding to loopback; the
  host allowlist rejects it. The existing browser client is same-origin + local, so this
  won't break it. Localhost-only; no new port. Unit-test same-origin, host-allowlist, and
  combined accept/reject (incl. the rebinding case).
- **Terminal output is never persisted to SDK/session history.** It flows only via
  `broadcastEvent` (live) + the in-memory ring (replay) — it is NOT written to the SDK
  `events.jsonl`, so nothing to filter on replay by default. Do NOT add `caco.term.*` to the
  shared `shouldFilter()` (`src/event-filter.ts`) — that filter gates BOTH live broadcast and
  history, so it would suppress live terminal output. If defense-in-depth is wanted, add a
  history-ONLY guard in `streamHistory()`. Also exclude `caco.term.*` from the generic applet
  `onSessionEvent` delivery (`public/ts/applet-runtime.ts`) so terminal bytes aren't exposed to
  applet event subscribers.

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
client → server:  caco.term.detach {}                 (panel closed / tab gone — keep pty)
client → server:  caco.term.kill   {}                 (explicit terminate)
server → client:  caco.term.output { data }           (session-scoped; ring-replayed on attach)
server → client:  caco.term.exit   { exitCode?, signal? }   (pty exited on its own)
```
**close = detach, not kill.** Multiple tabs can subscribe to one session
(`sessionSubscribers: Set<WebSocket>`); closing the panel in one tab must NOT kill the
shared pty. Track an attachment count per session; `detach` decrements; the pty is killed
only on session end, explicit `kill`, max-cap eviction, or its own exit.

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
- **@xterm/xterm**, **@xterm/addon-fit** (client, pure JS) — bundled via esbuild (scoped
  packages; unscoped `xterm`/`xterm-addon-fit` are deprecated). **xterm CSS:** esbuild bundles
  the JS but the HTML loads no TS-imported CSS today — **fold `@xterm/xterm/css/xterm.css` into
  `public/style.css`** (or add an esbuild CSS output + `<link>`), else the terminal renders
  broken.

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
- Closing the panel in one of two tabs on the same session does NOT kill the shared pty
  (detach semantics); the pty dies only on session delete / explicit kill / exit / eviction.
- A self-exiting shell emits `caco.term.exit`; the client marks it closed and the next attach
  respawns.
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
