# Terminal in Caco

Exploration of web-based terminal for interactive CLI use (lazygit, sudo, auth prompts, long-running processes).

## Use Cases

**Interactive TUI apps**: lazygit, htop, vim, less — need raw PTY with escape sequences, mouse events, alternate screen buffer.

**Auth/sudo**: Commands requiring user input (passwords, confirmations). Current `/api/shell` is fire-and-forget with no stdin.

**Long-running processes**: Watching builds, tailing logs, docker compose up. Current shell API has a 60s timeout.

**Agent-adjacent work**: User does manual terminal work alongside chat — currently requires switching to a separate terminal app.

## Current State

- `POST /api/shell` — run-and-return, no streaming, no stdin, ANSI stripped, 60s timeout
- Applets are inline DOM (no iframes), full window access, injected into `.applet-instance`
- WebSocket already exists at `/ws` for event streaming
- No terminal dependencies installed (no xterm, no node-pty)

## Options

### Option A: ttyd in iframe

[ttyd](https://github.com/nicm/ttyd) is a C binary that serves a terminal over HTTP/WebSocket. Available in Arch repos (`extra/ttyd`).

**How it works**: ttyd runs as a separate process on another port, serves its own xterm.js frontend. Caco embeds it in an iframe.

**Pros:**
- Zero code to write — `ttyd -p 53001 bash` and embed `<iframe src="http://localhost:53001">`
- Full PTY support (lazygit, vim, sudo all work)
- Battle-tested, widely used
- No npm dependencies, no node-pty compilation headaches
- Caco stays untouched — iframe is just a viewport

**Cons:**
- Separate process to manage (start/stop/restart)
- Separate port (CORS, or proxy through Express)
- iframe is a first for Caco — no existing iframe infrastructure
- Limited integration (can't easily read terminal state from Caco)
- Authentication: ttyd has basic auth but is separate from Caco's session model
- Styling: ttyd has its own theme, may not match Caco

**Complexity**: Very low. Install ttyd, add an iframe applet or a `/terminal` route.

### Option B: xterm.js + node-pty applet

Use `@xterm/xterm` (browser terminal renderer) + `node-pty` (server-side PTY) connected via Caco's WebSocket.

**How it works**: Applet loads xterm.js, connects to a new WS message type (e.g. `terminal.data`). Server spawns a PTY via node-pty, pipes data bidirectionally.

**Pros:**
- Fully integrated — same WebSocket, same session model
- Can share terminal state with agent (agent sees what user types)
- Consistent styling
- Single port, no CORS

**Cons:**
- `node-pty` requires native compilation (node-gyp, python, make). Fragile across Node versions. This is a notorious pain point.
- Significant server code: PTY lifecycle management, multiple terminal sessions, cleanup on disconnect
- xterm.js is ~300KB — large for an inline applet, and loading it as a script injection is awkward (it expects module imports, CSS files, addons)
- Applet sandboxing: xterm.js needs to create canvas elements, handle keyboard events globally — may conflict with Caco's own keyboard shortcuts
- WebSocket multiplexing: current WS is single-purpose (chat events). Adding terminal streams means protocol changes.

**Complexity**: High. Estimated 500-800 lines of new code across server + client + plumbing.

### Option C: xterm.js + ttyd backend (hybrid)

Use ttyd as the PTY backend but replace its frontend with xterm.js embedded in Caco's applet system. ttyd exposes a WebSocket protocol that xterm.js can connect to directly.

**Pros:**
- No node-pty (avoids native compilation)
- Full styling control
- ttyd's WS protocol is simple (just terminal data passthrough)

**Cons:**
- Still need xterm.js in the applet (size/loading concerns)
- ttyd WS protocol is undocumented and may change
- Two processes to manage
- More complex than pure iframe

**Complexity**: Medium.

### Option D: Separate tab/route

Add a `/terminal` route to Caco that serves a standalone terminal page (not embedded in the SPA).

**Pros:**
- Clean separation — no SPA integration headaches
- Can use any terminal solution (ttyd proxy, xterm.js, etc.)
- No keyboard shortcut conflicts
- Full viewport for terminal

**Cons:**
- Breaks the "everything in one view" model
- No visual integration with chat
- User has to context-switch between tabs

**Complexity**: Low, but low value — just a fancy bookmark to a terminal.

## Recommendation

**Start with Option A (ttyd in iframe).**

Rationale:
- ttyd is in Arch repos, one `pacman -S ttyd` away
- Zero application code for basic functionality
- iframe can go in the applet panel (right side, same as file-browser)
- Full PTY means lazygit, sudo, vim all work day one
- If integration needs grow later, migrate to Option B or C

### Implementation sketch for Option A

**Server side:**
- Start ttyd alongside Caco (in start.sh or as a managed child process)
- Proxy `/terminal/` through Express to ttyd's port (avoids CORS, keeps single port)
- Or: just let ttyd run on 53001 and iframe it directly (simpler)

**Client side:**
- New built-in applet `terminal` with `<iframe src="/terminal/" style="width:100%;height:100%;border:none">`
- Or: dedicated panel mode that replaces the applet panel with a full-height iframe
- Keyboard: iframe captures all input when focused — Escape key handling needs thought (leader key conflict)

**Process management:**
- start.sh: `ttyd -p 53001 -W bash &` (writable terminal)
- stop.sh: kill ttyd pid
- Or: Caco spawns ttyd as child process with lifecycle tied to server

### Open questions

- Should the terminal share the agent's cwd, or be independent?
- Multiple terminal sessions? ttyd supports `-m` for max clients but shares one session.
- How does Escape (Caco leader key) interact with terminal apps that use Escape (vim, lazygit)?
- Should Caco be able to read terminal output? (For agent awareness of what user is doing)
- Proxy vs separate port: proxy is cleaner but adds Express middleware complexity
