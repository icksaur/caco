# Caco

![Caco](caco.png)

A dangerous solution to any problem.

## What is this?

A self-extensible chat front-end for the [GitHub Copilot CLI SDK](https://github.com/github/copilot-sdk).

**Key capabilities:**
- Agent-generated custom "applets"
- Applet-to-agent collaboration
- Agent-to-agent collaboration
- Session scheduling
- Self modification and self introspection
- Document-centric meta-context
- Almost everything else Copilot-CLI can do

## Basic Architecture

```
Browser (localhost:53000)
    ↓ WebSocket + fetch
Express Server
    ↓ JSON-RPC
Copilot SDK → Copilot CLI → AI Models
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
npm install
npm run dev        # Start with auto-reload
```

Open `http://localhost:53000`

## Usage

Use the session UI via the session button.  Scheduled sessions appear here.  You can create new sessions, resume, rename, or delete sessions in the view.  The search is fuzzy-find and enter will resume a session.

Chat sessions started in the browser UI have a prompt explaining features to the agent.  Ask the agent about any features.

Long-press/click-and-hold on the applet button to load the applet browser, listing all applets.

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

- [doc/index.md](doc/index.md) - Documentation index
- [doc/doc-guidelines.md](doc/doc-guidelines.md) - Documentation standards
- [doc/API.md](doc/API.md) - Complete API reference