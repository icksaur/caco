# Caco

![Caco](caco.png)

A dangerous solution to any problem.

## What is this?

A self-extensible front-end for the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

**Key capabilities:**
- self modification and self introspection
- session-to-session orchestration, delegation, and scatter-gather
- extensibile slash commands, pound-completion, applets and internal tools
- custom UI elements for all those times a chat interface doesn't make sense
- almost everything else Copilot-CLI can do

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

## Requirements

- Node.js 18+
- GitHub Copilot CLI installed and authenticated
- GitHub Copilot subscription

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

### Autostart on Windows Login

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

## Usage

Toggle the session-view UI via the session button.  Scheduled sessions appear here.  You can select and create new sessions here.

Chat sessions started in the browser UI have a prompt explaining features to the agent.  Ask the agent about any features.

Long-press/click-and-hold on the applet button to load the applet browser.

Type a forward slash `/` to see all less-common controls, like session archival, model selection, and session renaming.

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | start leader timer |
| `Escape` `l` | Toggle session panel |
| `Escape` `.` | Toggle applet panel |
| `Escape` `,` | Expand applet panel |

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

doc/                # Design docs and API reference
tests/              # Vitest unit tests
```

## User Data (`~/.caco/`)

```
~/.caco/
├── applets/       # Saved applets (each: meta.json, content.html, script.js, style.css)
├── sessions/      # Chat session state (UUID dirs with messages, outputs, state)
└── usage.json     # Token usage tracking
```

## Documentation

- [API.md](API.md) - Complete API reference
- [APPLETS.md](APPLETS.md) - Applet authoring guide
- [EXTENSIONS.md](EXTENSIONS.md) - Extensions and skills