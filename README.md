# Caco

A self-extensible chat front-end for the [GitHub Copilot CLI SDK](https://github.com/github/copilot-sdk).

## What is this?

A local web interface for Copilot that the agent can extend at runtime.

**Key capabilities:**
- Chat interface with streaming responses
- Session management (multiple simultaneous conversations)
- Image attachments (paste in chat input)
- Media embedding
- Agent-generated custom "applets"
- Applet-to-agent collaboration
- Agent-to-agent collaboration
- Session scheduling
- Self modification and self introspection

## Basic Architecture

```
Browser (localhost:3000)
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

Open `http://localhost:3000`

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

See [doc/API.md](doc/API.md) for complete API reference including:
- HTTP endpoints (sessions, streaming, applets, files)
- MCP tools (set_applet_content, save_applet, display tools)
- JavaScript APIs for applet code (setAppletState, loadApplet, navigation)
- WebSocket events for real-time streaming
- File storage structure

## License

MIT