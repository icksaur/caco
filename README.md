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
npm ci && npm run build && ./start.sh
```

```powershell
npm ci && npm run build && .\start.ps1
```

Open `http://localhost:53000`

> Use `npm ci`, not `npm install`, for a plain checkout — it installs exactly
> what's committed in `package-lock.json` and never rewrites it. This matters
> on a network whose npm registry is a corporate feed/mirror: `npm install`
> can re-resolve packages through that feed and silently downgrade the
> lockfile's integrity hashes / rewrite its URLs, which the `check:lockfile`
> gate will then reject on your next push. If you need to add or upgrade a
> dependency (which does require `npm install`), see **Development** below.

### Updating

```bash
git pull && npm ci && npm run build
```

`npm ci` deletes and reinstalls all of `node_modules`. On Linux and macOS
that works while Caco is running: a running process keeps its open files
even after they are deleted, and the next restart picks up the new ones.

**On Windows, a running Caco locks its executables** (`esbuild.exe` from tsx,
the SDK's `copilot-runtime.exe`, node-pty's native module), so `npm ci` fails
with `EPERM` while Caco is up. Pull first, then choose by whether the pull
changed `package-lock.json` (`git diff --stat HEAD@{1} -- package-lock.json`):

- **Lockfile unchanged:** update in place with `npm install && npm run build`,
  then restart Caco. `npm install` only touches packages whose versions
  changed, so with nothing changed it leaves the locked files alone.
- **Lockfile changed:** stop Caco, run `npm ci && npm run build`, then start
  it again.

If `npm ci` does fail with `EPERM` while Caco is running, `node_modules` is
left partially deleted. Caco keeps working on what it already has loaded, but
fails as soon as it needs a fresh SDK runtime (after the 30-minute idle
reconnect, or a restart) with `Could not resolve @github/copilot-sdk-<platform>`.
Run `npm install` (in place) or stop Caco and `npm ci` to restore it.

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

### Terminal Emulator

Each session has an integrated terminal — a real, user-identity shell (PowerShell on
Windows; your login `$SHELL`, e.g. bash/fish/zsh, on macOS/Linux) running in the session's
working directory.

- **Toggle** with the `>` glyph mid-right in the context footer, or press `` Ctrl+` ``. The
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
- Instances are saved in `localStorage` and reconnect on reload. Every instance loads at startup, so badges and the merged pager cover all of them.
- **Merged pager.** The `PG` button at the top of the sidebar (or `/portal.html#pager`) opens one pager board for every instance. Each card and busy row is labeled with its instance. Send and Dismiss go to the instance that owns the session, and clicking a session name opens it in that instance. An instance that is down shows as `unreachable` without breaking the board. Its count badge shows how many cards are waiting.
- **Remote instances and the merged pager.** Each remote instance only answers a portal on an origin it trusts, because the board can send prompts. By default that is `http://localhost:53000` (and `http://127.0.0.1:53000`), so no setup is needed when you open the portal there. If your portal is at a different address, set `CACO_PORTAL_ORIGINS` on each remote instance to that origin and restart it (comma-separate several; the list replaces the default). Set `CACO_PORTAL_ORIGINS=none` to turn the bridge off for other origins. When an instance refuses, the board lists it as not connected and shows the value to use. See [docs/spec-portal-pager.md](docs/spec-portal-pager.md).

### Pager

Open `/pager.html` to triage finished work in one place, away from the main UI.
To triage several machines on one board, use the merged pager in the [Portal](#portal).

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
  Repeating the same options word for word is not a new offer.
- **Scheduled wakes keep the offer.** A scheduler message does not clear a pending
  offer, and a scheduled turn sets the unobserved dot only when it makes a new
  offer. A wake that finds nothing to decide stays silent.
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

Caco runs agentic sessions on a cron schedule — unattended, recurring automation. Slug schedules and session wakes are listed in the Job Scheduler applet (`/?applet=jobs`). Create schedules via the REST API (see `API.md`) or ask your agent to set one up. A run's result reads `running` until its turn really ends, then `success`, `error`, or `cancelled` (you pressed Stop).

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

#### Session wakes

A session can ask to be woken later with the always-available `caco_wake` tool,
for example a long-lived session waiting on a PR review or a deployment. The
wake prompt is short (local time, time since the last wake, the session's own
note, and how to stop). A wake that ends quietly leaves no badge. A wake that
writes a new `caco-actions` offer marks the session unobserved and lands in the
pager. Sessions with a wake show a "wake Nh" badge in the session list
("wake paused" when paused), and the Job Scheduler applet lists every wake
with a Stop button.

- Cadence is 1-24 hours, one wake per session. Archiving a session clears its wake.
- A wake skips a busy session, a session with a human message in the last 30
  minutes, and off-hours. Skipped wakes retry on the next check (every 5 min).
- After 3 failed wakes in a row the wake pauses and the session is marked unobserved.
- After 7 days with no human message, one final wake asks you whether to keep
  waiting. If you don't renew, the wake pauses.
- An imported copy arrives paused. A move (`export?delete=true`) stays armed.

| env var | default | meaning |
|---|---|---|
| `CACO_WAKE_WINDOW` | `Mon-Fri 07:00-19:00` (server-local) | Hours when wakes may fire. Add an IANA zone if the machine's zone isn't yours, e.g. `Mon-Fri 07:00-19:00 America/Los_Angeles`. `always` disables the window. |
| `CACO_WAKE_MAX` | `20` | Active (unpaused) wakes allowed across all sessions |
| `CACO_WAKE_MAX_RUNNING` | `2` | Wake turns allowed to run at once; the rest wait a tick |
| `CACO_WAKE_EXPIRE_MS` | `604800000` (7 days) | Time without a human message before the final wake |
| `CACO_WAKE_CHECK_INTERVAL_MS` | `300000` (5 min) | Wake loop check interval |

Adding `caco_wake` to `CACO_DISABLED_TOOLS` turns wakes off entirely. See
[docs/spec-session-wake.md](docs/spec-session-wake.md).

### Comms guard

Agents don't send messages people read. In a turn you didn't start (wakes,
slug schedules, delegated or herd workers, agent, system and applet messages,
and their continuations), Caco denies tools that send mail, Teams messages, PR
or work item comments (including work item updates that write
`System.History`), reviewer changes, or IcM posts and state changes, plus the
general-purpose `workiq-do_action`/`create_entity`/`update_entity`/`delete_entity`
and `computer-use-*` tools. The
model is told to write a draft and offer it as a `caco-actions` option.
Drafts (`CreateDraftMessage`, `UpdateDraft`), `teams-SendMessageToSelf`, and
resolving PR threads stay allowed. Turns you start by typing a message or
invoking a skill are not blocked. Each denial is logged as
`[COMMS-GUARD] Denied <tool> in <session>`. This is defense in depth, not a
sandbox: a turn with shell access can still reach anything, including Caco's
own message route.

Set it with `POST /api/preferences`:

```bash
# Block in every turn, including yours ('unattended' is the default, 'off' disables)
curl -X POST http://localhost:53000/api/preferences -H "Content-Type: application/json" \
  -d '{"commsGuard": "always"}'
# Replace the guarded tool-name patterns ([] restores the defaults)
curl -X POST http://localhost:53000/api/preferences -H "Content-Type: application/json" \
  -d '{"commsGuardPatterns": ["SendEmail*", "Reply*ToMessage", "repo_pull_request_thread_write#create,reply"]}'
```

Patterns are case-insensitive globs and match with or without the server
prefix (`ReplyToMessage` matches `mail-ReplyToMessage`). `#a,b` limits a
pattern to those `action` values. The default list is in
[docs/spec-comms-guard.md](docs/spec-comms-guard.md).

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

See [docs/spec-byok.md](docs/spec-byok.md) for the design.

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

Adding or upgrading a dependency requires `npm install`, which can mutate
`package-lock.json`. On a corporate npm feed this can rewrite `resolved` URLs
and downgrade integrity hashes to sha1 — a pre-push gate (`check:lockfile`)
catches this before it reaches the repo. If it flags your lockfile, run
`npm run fix:lockfile` to restore the committed public-registry metadata for
unchanged packages and fetch fresh sha512 metadata for anything new (this
needs a path to the real `registry.npmjs.org` for that one command, even if
your default registry is a corporate feed).

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
