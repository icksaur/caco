# spec-integrated-terminal

Status: **done** (shipped to master). Disposable feature spec, rewritten to capture the
as-built design. node-pty + xterm.js integrated terminal, one pty per session under the
context footer.

## Fit
- Goal it serves: a first-class, session-bound interactive shell in the Caco UI (core
  feature, not an extension) — the user's real terminal under the meta-context footer.
- Invariants in scope:
  - **Terminal I/O is session-scoped and server-authoritative.** The session a ws acts on
    comes only from the server-side subscription (`clientSubscription.get(ws)`), never a
    client-supplied id — no cross-session spoofing.
  - **Terminal output is never persisted to SDK/session history.** It flows only via
    `broadcastEvent` (live) + the in-memory ring (replay); it is not written to
    `events.jsonl` and is not exposed to applet event subscribers.
  - **pty lifetime = session lifetime.** A pty is killed on session delete, explicit kill,
    LRU eviction, its own exit, or process exit — never on mere panel/tab close (detach).
  - **The ws upgrade is same-origin + trusted-host gated** (DNS-rebinding-safe), since a
    real shell is a direct command channel.
  - **Browsing sessions never spawns a terminal.** A pty is created only on an explicit
    spawn (`spawn:true`, a user action); a passive attach (session switch / reconnect)
    returns idle without starting a shell.
- Contradiction check: none. Reuses the existing per-session `broadcastEvent`, the ws
  subscription map, and `resolveShell`; adds no new port and no new persistence surface.

## Goals
A small `>` glyph mid-right in the context footer toggles a terminal panel below the
footer. Opening it lazily spawns one interactive shell per session — PowerShell on
Windows; the user's **login shell** (`$SHELL`, e.g. fish/zsh, falling back to bash→sh) on
POSIX — running as the Caco server's identity in the **session's cwd**. Switching sessions
swaps the visible xterm; background ptys keep running and their output is ring-replayed on
return. Closing the panel detaches (pty survives); the pty dies with the session. The
panel height is **drag-resizable** via a blue bar on its top edge (matching the
session-list / applet-panel resizers), persisted across reloads.

## Design

**Mechanism chosen:** native `node-pty` for the server pty (the only mature cross-platform
pty for Node; viability confirmed on Node 26) + `@xterm/xterm` + `@xterm/addon-fit` on the
client, bundled through the existing esbuild `build:client` (no static serving). Transport
is JSON frames over the **existing** `/ws`, not a new socket/port.

**Server — `src/terminal-manager.ts`.** `terminals: Map<sessionId, TerminalEntry>` where an
entry holds `{ pty, ring: RingBuffer, attachCount, pendingOut, flushTimer, lastActivity }`.
- `resolveInteractiveShell({platform, env, exists})` honors the user's POSIX **login
  shell** first (`$SHELL`, e.g. fish/zsh, when it exists) so the terminal feels native;
  otherwise it falls back to `resolveShell()` (`src/workflow/shell.ts`) launched
  **interactively** — `interactiveShellArgs()` yields PowerShell `-NoLogo` (not the
  workflow's `-Command`/`-NonInteractive` exec flags), bash/sh no exec flag.
- `ensureTerminal(sid, cols, rows, allowSpawn)`: if a live pty exists, attach (increment
  count), resize it to the client's fitted size, and return its ring snapshot. Otherwise,
  spawn a new shell **only when `allowSpawn`** (explicit user spawn) — in the session's cwd
  (`sessionManager.getSessionCwd`; reject if null) with a cleaned env, registering
  `onData`/`onExit`; a passive attach (`allowSpawn` false) returns `{ idle: true }` without
  starting a shell. The returned ring is delivered ONLY to the attaching client.
- **Output coalescing:** `onPtyData` accumulates into `pendingOut` and flushes on a 16 ms
  timer or when `pendingOut` hits `MAX_FRAME_BYTES`. `flushOutput` pushes the flushed bytes
  to the ring **and then** broadcasts — so the ring only ever holds already-broadcast
  bytes, and an attach snapshot can never overlap output still queued for live broadcast
  (no double-render on re-attach during active output).
- **Lifetime:** `initTerminalManager()` registers `sessionState.onSessionEnd` →
  `killTerminal` and a non-suppressing process `exit` hook → `killAllTerminals` (it does
  **not** own SIGINT/SIGTERM, so the server's graceful-shutdown path is preserved).
  `teardown` does a process-group kill. `enforceCap` LRU-evicts beyond the max-terminal cap.
- Bounded `RingBuffer` (byte-capped scrollback) per session, snapshot-replayed on attach.

**WebSocket — `src/routes/websocket.ts`.** `caco.term.*` are core cases in
`handleMessage`'s `switch`, keyed by `clientSubscription.get(ws)` (reject if absent):
`attach{cols,rows,spawn?}` → `ensureTerminal`; the attaching client gets `caco.term.idle`
(no pty — passive attach) or `caco.term.live{ring}` (ring replay, possibly empty),
replied only to that client (live output reaches other tabs via `broadcastEvent`).
`input{data,binary?}` → `writeTerminalInput`; `resize{cols,rows}` → `resizeTerminal`;
`detach{}` → `detachTerminal` (decrement, keep pty); `kill{}` → `killTerminal`. The pty's
`onExit` broadcasts `caco.term.exit{exitCode,signal}`. **Binary input:** xterm emits
terminal report replies (DA/DSR/cursor-position) on `onBinary` as a **Latin-1 byte
string**, flagged `binary:true`; `decodeTerminalInput` turns it back into raw bytes via
`Buffer.from(data,'binary')` (not base64) so full-screen TUIs (vim, the Copilot CLI, fish)
that block on these replies work.

**Origin guard — `src/security/same-origin.ts`.** `verifyWsUpgrade` (used by the ws
`verifyClient`) allows iff Origin is absent OR (`URL(origin).host === Host` AND the Host
hostname ∈ trusted set). `parseTrustedHosts` defaults to loopback (`localhost`,
`127.0.0.1`, `[::1]`) plus an additive opt-in `CACO_TRUSTED_HOSTS`. The host check is the
DNS-rebinding guard (a rebinding page passes pure same-origin); Dev Tunnels rewrite
Host→localhost so it is zero-config over a tunnel.

**History/applet exclusion.** Terminal events are not added to `shouldFilter`
(`src/event-filter.ts`) — that filter gates both live and history, so adding them would
suppress live output. Persistence is avoided structurally (never written to `events.jsonl`).
`public/ts/applet-runtime.ts` drops `caco.term.*` before applet event delivery.

**Client — `public/ts/terminal-panel.ts` + `public/style.css`.** `initTerminalPanel()`
(called at boot) **injects the UI dynamically** — it is not in `index.html`: a
`<button id="termToggle" class="term-toggle">` with text `>` appended to `#contextFooter`,
and a `<div class="terminal-panel hidden">` appended as the **last child of `#chatFooter`**
so the panel renders below the footer with `.chat-scroll` (flex:1) shrinking to fit.
`terms: Map<sessionId,{term,fit,el,live}>`; only the active session's element is visible.
xterm loads `@xterm/addon-fit` (sizing) and `@xterm/addon-canvas` (canvas renderer); xterm
CSS is folded into `public/style.css` (the bundle imports no CSS).
- **Toggle = explicit spawn.** Click the glyph or press `Ctrl+\`` → `toggle()`; opening the
  panel calls `startTerminal()` (attach with `spawn:true`), the only path that starts a
  shell. This is what honors the no-spawn-on-browse invariant: a session switch / reconnect
  re-reveals the panel via a **passive** attach (`revealActive`, `spawn` false) that
  continues an existing pty but never starts one.
- **Long-press the glyph restarts** the session's shell (kill + respawn); the long-press
  suppresses the click so it doesn't also toggle. (Title: "Toggle terminal (Ctrl+\`) —
  long-press to restart".)
- An xterm entry starts **not-live** and a keypress shows a placeholder until the server
  confirms a pty with `caco.term.live`; on (re-)attach the client **resets xterm first** so
  ring replay is an exact reconstruction, then fits and sends `caco.term.resize`.
  `term.onData`→`input`; `term.onBinary`→`input` with `binary:true`. The glyph gets an
  `active` class while open.
- **Vertical drag-resize.** A `<div class="terminal-resizer">` is injected as the panel's
  top-edge sibling (directly above `#terminalPanel` in `#chatFooter`), visible only while
  the panel is open. It mirrors the existing `.panel-resizer` treatment — transparent,
  5px, `var(--color-accent)` on hover/`.dragging` — but **vertical** (`cursor:row-resize`,
  resizes `height` not `width`). Dragging up grows the panel (`height = startHeight +
  (startY − clientY)`, clamped `MIN_TERM_HEIGHT`..80vh); the height persists to
  `localStorage['caco:terminalPanelHeight']` and is reapplied on boot. Because resizing the
  panel changes the xterm viewport, the client **refits the active terminal during the drag
  (rAF-throttled) and on release**, sending `caco.term.resize` so the pty winsize tracks.
  The drag logic lives in `terminal-panel.ts` (not the generic `panel-resizer.ts`, which is
  width-only and id-bound at boot) because the terminal panel + resizer are created
  dynamically and held by reference.

## Considerations
- **Real shell = direct command channel** (stronger than the agent-mediated workflow).
  Mitigated by: server-known subscribed session, the same-origin+trusted-host ws guard,
  loopback-only by default, and output excluded from persisted history.
- **node-pty native build.** Server runs via `tsx` (not bundled). `npm install` must build
  `pty.node` under the allow-scripts policy (Linux toolchain present; Windows/macOS use
  prebuilds).
- **Throughput.** PTY data is string-oriented; 16 ms coalescing + `MAX_FRAME_BYTES` cap +
  bounded ring keep frames sane. Binary **input** (xterm `onBinary` report replies, Latin-1
  bytes) is forwarded as raw bytes; binary output not needed for V1.
- **Resize staleness.** Re-attach resizes the existing pty to the client's fitted
  cols/rows so winsize never goes stale across session-swap/reconnect.
- **Resize → ws-resize spam.** Dragging the height bar refits xterm continuously; throttle
  the refit/`caco.term.resize` to one per animation frame during the drag, with a final
  fit on release, so the pty winsize updates smoothly without flooding the ws.
- **Rejected:** keeping it an extension (TTL reaping, client sid-stamping, ring-replay to
  dodge event delivery, duplicate shell resolver, static xterm) — every workaround vanished
  by going core. See Rationale.

## Acceptance
- Observable: `initTerminalPanel()` injects the `>` glyph mid-right in the footer and the
  panel below it. Clicking the glyph (or `Ctrl+\``) opens the panel and spawns a shell as
  the user in the **session's cwd** (a scratch file created under the session cwd appears —
  not `/tmp`); PowerShell on Windows, `$SHELL`/bash on POSIX. Long-pressing the glyph
  restarts the shell. Merely switching sessions does **not** spawn a shell. Switch-and-back
  shows the correct, isolated terminal with the prior session's view ring-replayed. Two
  tabs on one session: closing the panel in one does **not** kill the shared pty; the pty
  dies on session delete / explicit kill / exit / eviction. A self-exiting shell emits
  `  caco.term.exit` and the next open respawns. **Dragging the blue top-edge bar resizes the
  panel height; the terminal reflows and the height persists across panel toggles and page
  reload.** (Visual signoff obtained for the panel/glyph layout and the resize bar.)
- Budgets: output coalesced to ≤1 frame / 16 ms with a per-frame byte cap; per-session ring
  byte-capped; max-terminal cap with LRU eviction.
- Gates: `npm run build` (build:client + typecheck ×2 + lint:strict + knip + tests +
  scan:pii + check:vendor) green.
- Oracles (each pins a behavior; the rest are by-construction, noted):
  - pure units — `decodeTerminalInput` (UTF-8 passthrough vs Latin-1 onBinary→bytes),
    `interactiveShellArgs` (PowerShell `-NoLogo`, bash/sh none), `resolveInteractiveShell`
    (`$SHELL` honored / fallback / Windows), `RingBuffer` (cap eviction, oversized-final,
    empty push) → `tests/unit/terminal-manager.test.ts`.
  - client LRU eviction policy (`selectEvictions`: never evict active, drop oldest beyond
    cap) → `tests/unit/terminal-lru.test.ts`.
  - origin/host accept-reject incl. DNS-rebinding + absent-Origin →
    `tests/unit/terminal-origin.test.ts` (`verifyWsUpgrade`).
  - boot-order guard (`initTerminalManager` throws if called before `createSessionState`) →
    `tests/unit/terminal-init-order.test.ts`.
  - **By-construction (no isolated test; verified by code review + manual acceptance):**
    session-scoping/no-spoof (session read only from `clientSubscription`), no-persist
    (terminal events never written to `events.jsonl`, excluded in `applet-runtime`),
    pty-lifetime/detach + process-group teardown, passive-attach-never-spawns, server
    `enforceCap` LRU. These are integration-level and were validated via the live
    acceptance run, not a unit oracle.

## Plan
All steps complete (shipped). Listed for traceability.

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add node-pty + @xterm/xterm + @xterm/addon-fit + @xterm/addon-canvas; confirm native build + esbuild bundle | `package.json` | build gate (build:client + install) | - |
| 2 | Terminal manager: ring, `$SHELL`-first interactive shell resolve, lazy spawn-on-explicit in session cwd, coalesced flush, LRU cap, onSessionEnd/exit teardown, onBinary input decode | `src/terminal-manager.ts` | `terminal-manager.test.ts` (RingBuffer, shell resolve, decodeTerminalInput, args); `terminal-init-order.test.ts` (boot guard) | pty-lifetime; no-persist; no-spawn-on-browse |
| 3 | WS handlers keyed by `clientSubscription` (attach idle/live, input/resize/detach/kill, exit broadcast); applet exclusion | `src/routes/websocket.ts`, `public/ts/applet-runtime.ts` | by-construction: server-authoritative session + no-persist (code review + acceptance) | session-scoped; no-persist |
| 4 | Same-origin + trusted-host ws guard (DNS-rebinding-safe) | `src/security/same-origin.ts`, `src/routes/websocket.ts` | `terminal-origin.test.ts` | same-origin guard |
| 5 | Client panel + CSS: `initTerminalPanel()` injects glyph (`>`) + panel-below-footer + top-edge vertical resize bar, bundled xterm (+fit/canvas), toggle=explicit-spawn vs passive switch-reveal, long-press restart, reset-on-attach, active-session swap, fit/resize, onData/onBinary forward | `public/ts/terminal-panel.ts`, `public/ts/terminal-lru.ts`, `public/style.css` | `terminal-lru.test.ts` (eviction policy); visual signoff | no-spawn-on-browse |
| 6 | Vertical drag-resize: `.terminal-resizer` (blue, row-resize) above the panel; drag sets/persists `height` (`caco:terminalPanelHeight`), rAF-throttled refit + `caco.term.resize` | `public/ts/terminal-panel.ts`, `public/style.css` | visual signoff | - |

**Non-goals (not in V1):** scrollback persistence across restart, split panes, copy/paste
toolbar, per-session env customization, multiple terminals per session, mobile layout.

## Rationale (skippable)
Built core rather than as an extension because the extension boundary forced a pile of
workarounds — TTL reaping instead of real lifetime, client sid-stamping, ring-buffer replay
to dodge event delivery, a duplicate shell resolver, static-served xterm, a no-op footer
slot. Core has first-class access to session lifecycle (`onSessionEnd`), the ws↔session
subscription, session cwd, the esbuild pipeline, and the footer DOM — so the pty becomes a
true child of the session and every workaround disappears. The same-origin host-allowlist
(over plain same-origin) is required because a DNS-rebinding page presents matching
Origin/Host for its own domain after rebinding to loopback; the trusted-host set rejects it
while staying zero-config for the local browser and over Dev Tunnels (Host→localhost).
