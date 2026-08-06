# Caco

![Caco](caco.png)

## What is this?

A self-extensible web-based wrapper for the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

**Key capabilities:**
- agent-to-agent orchestration, delegation, and scatter-gather
- custom UI elements called "applets" for when chat interface doesn't make sense
- ad-hoc per-session surface for UI-to-agent collaboration
- extensibile slash commands, pound-completion, tools, and applets
- scheduled tasks
- BYOK provider support
- HTTP client/server architecture
- self modification and self introspection
- almost everything else Copilot-CLI can do

## Requirements

- Node.js 18+
- GitHub Copilot subscription
- GitHub Copilot CLI installed and authenticated

```bash
copilot --version  # Verify CLI works
```

## Quick Start

```bash
npm install && npm run build && ./start.sh
```

```powershell
npm install && npm run build && .\start.ps1
```

Open `http://localhost:53000`

## Usage

Toggle the session-view UI via the session button.  Scheduled sessions appear here.  You can select and create new sessions here.

Chat sessions started in the browser UI have a prompt explaining features to the agent.  Ask the agent about any features.

**Click-and-hold/long-press on the applet button to load the applet browser.**

Type a forward slash `/` to see all less-common controls, like session archival, model selection, and session renaming.

## Autostart on Windows Login

A VBS wrapper launches Caco in the background with no visible window:

```powershell
# Create startup shortcut (one-time setup)
$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$startup\Caco.lnk")
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "<path-to-caco>\start-hidden.vbs"
$sc.WorkingDirectory = "<path-to-caco>"
$sc.WindowStyle = 7
$sc.Save()
```

To remove: `Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Caco.lnk"`

## Advanced Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/caco.session-new` | New chat |
| `/caco.agent <name> <prompt>` | Dispatch prompt with an SDK custom agent |
| `/caco.session-rename <name>` | Rename current session |
| `/caco.session-cwd <path>` | Change session working directory |
| `/caco.session-folder <name>` | Move session to a folder (or "/" for root) |
| `/caco.session-archive` | Archive current session |
| `/caco.session-model` | Change session model |
| `/caco.session-export` | Export current session as .tar.gz |
| `/caco.session-fork [message]` | Fork session into a new side conversation (inherits history) |
| `/caco.session-compact` | Force context compaction |
| `/caco.session-context-window [tokens]` | Cap session context window so it compacts earlier (cuts per-call cost); no arg opens a picker |
| `/caco.session-effort` | Set reasoning effort level for models that support it (picker) |
| `/caco.plugin-directory [paths\|clear]` | Load Open Plugins directories into this session only (never into `~/.copilot`); no arg shows the current list |
| `/caco.restart` | Restart the Caco server |

### Portal

Open `/portal.html` to aggregate multiple Caco instances in a single view. Each instance runs on a different machine or directory and is accessed by its URL.

- **Sidebar** shows connected instances as icons. Click to switch between them.
- **Add instances** by clicking the `+` button and entering the Caco URL (e.g., `http://work-machine:53000`).
- **Drag-and-drop sessions** between instances to transfer them. Drag a session from one instance's session list and drop it on another instance's sidebar icon. The session archive is exported from the source and imported at the destination.
- Instances are saved in `localStorage` and reconnect on reload.

### Terminal Emulator

  panel opens below the footer; opening it is what starts the shell.
- **Long-press the glyph to restart** the shell (kill + respawn) — an escape hatch for a
  wedged terminal.
- **One terminal per session.** Terminals **stay open regardless of visibility** — closing
  the panel or switching sessions only hides it; the shell keeps running in the background
  and its output is restored when you return. Merely browsing sessions never starts a shell.
- A terminal ends only when: you **exit the shell** (e.g. `exit`), it is **evicted** (a cap
  of 16 live terminals; the least-recently-used is closed beyond that), or the **Caco server
  process stops** (e.g. `/caco.restart`).

### Portal

Open `/portal.html` to aggregate multiple Caco instances in a single view. Each instance runs on a different machine or directory and is accessed by its URL.

- **Sidebar** shows connected instances as icons. Click to switch between them.
- **Add instances** by clicking the `+` button and entering the Caco URL (e.g., `http://work-machine:53000`).
- **Drag-and-drop sessions** between instances to transfer them. Drag a session from one instance's session list and drop it on another instance's sidebar icon. The session archive is exported from the source and imported at the destination.
- Instances are saved in `localStorage` and reconnect on reload.

### Pager

Open `/pager.html` to triage finished work in one place, away from the main UI.

- **One row per running session**, each with its own indicator, so you can read which
  session is working rather than just how many are.
- **A card appears** for every session that has stopped and is holding an unhandled
  offer — its last message ended with a `caco-actions` block — showing the session
  name and the full text of every action it offered.
- **Click an action** to put that exact text in the card's well; press **Send** to
  deliver it and the card leaves the board. The click stages rather than sends, so
  a mis-tap costs nothing and you can amend the wording first. **Dismiss** takes
  the card off the board without sending anything.
- **Or write your own.** Each card has a *something else …* well below its options;
  typing in it reveals **Send**, which delivers your text just like an option. Your
  typing survives the board's background refreshes and is only discarded when you
  send or dismiss.
- **The pager is independent of the unobserved dot.** It does not care whether you
  or another machine has viewed the session, and dismissing here does not clear the
  dot anywhere. Its unit of work is the *offer*, not the session: dismiss hides the
  current offer, and a card returns only when a session makes a **new** one.
- **Offers expire after 7 days.** An old offer refers to a state of the world that
  has moved on, so the board decays on its own rather than needing to be tended.
- The board updates on its own — no reload — via `GET /api/pager?since=<version>&wait=<ms>`,
  which holds for up to 10s and returns the whole board whenever it changes. Because
  every response is a complete snapshot, a missed update costs at most 10s of
  staleness and never leaves the board wrong.
- **Herd children and swarm sessions raise no cards.** Each is driven and drained by
  the agent that spawned it, so it is never waiting on a human. Scheduled runs *do*
  raise cards — a job that finished overnight with nobody watching is the case the
  pager exists for. Every running session shows a row regardless.

### Scheduled Sessions

Caco runs agentic sessions on a cron schedule — unattended, recurring automation. Scheduled sessions appear in the session panel with a clock icon. Create them via the REST API (see `API.md`) or ask your agent to set one up.

**Example scenarios:**

- **Self-learning system prompts** — Weekly analysis of your chat patterns to refine `copilot-instructions.md`. The scheduled session reads recent conversations, identifies recurring requests and preferences, and updates your system prompt.
- **Server monitoring** — Hourly health checks that SSH into servers, run diagnostics, and flag anomalies in a session note.
- **Productivity summaries** — Weekly digest of what you accomplished across sessions, using `session_store_sql` to query conversation history.
- **Daily planning digest** — Morning session that reads your calendar and email via Gmail or Outlook MCP servers, produces a prioritized daily plan.

```bash
# Example: create a weekly self-improvement schedule
curl -X PUT http://localhost:53000/api/schedule/weekly-review \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Review my recent sessions. Identify patterns in what I ask for. Suggest improvements to copilot-instructions.md.",
    "schedule": { "type": "cron", "expression": "0 9 * * 1" },
    "sessionConfig": { "model": "claude-sonnet-4.5", "persistSession": true }
  }'
```

### Copilot-CLI Configuration

Caco wraps the Copilot SDK which wraps Copilot-CLI. You can configure Copilot-CLI behavior, and Caco agents can help set these up:

**System prompts** (`copilot-instructions.md`):
- Place in your project root or `~/.copilot/` for global instructions
- Copilot-CLI reads this file and includes it in every session's context
- Ask your Caco agent to help write or refine these instructions based on your workflow

**MCP servers** (`~/.copilot/mcp-config.json`):
- Configure external tool servers (database access, APIs, custom tools)
- Open the MCP Servers applet (`/?applet=mcp-servers`) to view server status and discovered tools
- Ask your agent to help configure new MCP servers

**Skills** (`.copilot/skills/<name>/SKILL.md` or `~/.copilot/skills/<name>/SKILL.md`):
- Markdown files that define reusable workflows the agent can invoke
- Project-level skills in `.copilot/skills/` or user-level in `~/.copilot/skills/`
- Ask your agent to help create skills for your common workflows

**Hooks** (`.copilot/hooks/`):
- Shell scripts that run automatically at lifecycle points (e.g., before/after tool execution)
- Use for custom validation, logging, or environment setup
- Ask your agent to help create hooks for your project

### Model Providers (BYOK)

Alternative model providers are a Copilot SDK feature.  Please see the official documentation for full configuration information.

```
    "ollama": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1",      // no key needed for local
      "models": [
        { "id": "qwen2.5-coder:32b", "name": "Qwen2.5 Coder 32B", "contextWindow": 32768 }
      ]
    }
  }
}
```

**Notes:**
- **Credentials are env-var *names*, never inline secrets.** Use `apiKeyEnv`, or `bearerTokenEnv` for bearer-token auth (takes precedence), or `headersEnv` (a map of header name → env var) for proxies needing static headers. Both are optional for local providers.
- The env vars must be set in the **server's** environment before it starts — Caco reads them when a session is created, not from your post-launch shell.
- BYOK model ids are namespaced `providerId:modelId` (e.g. `openrouter:anthropic/claude-opus-4`); a provider key must not contain `:`.
- Optional per-model `agentModel` picks the Copilot-known model used for agent configuration (tools/prompts/limits); it defaults to a sane model if omitted.
- A missing or malformed file, or a model with an unset key, never breaks GitHub models — listing continues and only the affected BYOK model fails (at session start, with a clear message).
- Editing the file takes effect on the next server restart.

See [docs/multi-provider.md](docs/multi-provider.md) for background and [docs/byok-spec.md](docs/byok-spec.md) for the design.

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | start leader timer |
| `Escape` `l` | Toggle session panel |
| `Escape` `.` | Toggle applet panel |
| `Escape` `,` | Expand applet panel |

## Basic Architecture

```
Browser (localhost:53000)
    ↓ WebSocket + fetch
Express Server
    ↓ JSON-RPC
Copilot SDK → Copilot-CLI → GitHub Copilot
```

**Frontend:** TypeScript, bundled with esbuild  
**Backend:** Node.js + Express + Copilot SDK  
**Streaming:** WebSocket (real-time events)

## Development

```bash
npm run build      # Build + typecheck + lint + test
npm run dev        # Development server (nodemon)
npm test           # Run tests
```

## Project Structure

```
public/
├── ts/            # Frontend TypeScript (bundled to bundle.js)
├── index.html     # Single-page app
└── style.css      # All styling

src/
├── server.ts      # Express server entry point
├── session-manager.ts  # Copilot session lifecycle
├── routes/        # API endpoints
└── tools/         # MCP tool implementations

docs/               # Design docs, version specs, API reference
tests/              # Vitest unit tests
```

## User Data (`~/.caco/`)

```
~/.caco/
├── applets/       # Saved applets (each: meta.json, content.html, script.js, style.css)
├── providers.json # Optional: BYOK model providers (see "Model Providers" above)
├── sessions/      # Chat session state (UUID dirs with messages, outputs, state)
└── usage.json     # Token usage tracking
```

## Documentation

- [API.md](API.md) - Complete API reference
- [APPLETS.md](APPLETS.md) - Applet authoring guide
- [EXTENSIONS.md](EXTENSIONS.md) - Extensions and skills
