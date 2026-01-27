# Copilot Web

A self-extensible chat front-end for the [GitHub Copilot CLI SDK](https://github.com/github/copilot-sdk).

## What is this?

A local web interface for Copilot that the agent can extend at runtime. The agent can create custom interactive applets in the browser—file browsers, dashboards, forms—without modifying the codebase.

**Key capabilities:**
- Chat interface with streaming responses
- Session management (multiple conversations)
- Image attachments (paste to send)
- Agent-generated custom applets via MCP tools
- Applet navigation stack with breadcrumbs
- File operations for custom applets

## Architecture

```
Browser (localhost:3000)
    ↓ fetch / SSE
Express Server
    ↓ JSON-RPC
Copilot SDK → Copilot CLI → AI Models
```

**Frontend:** TypeScript, bundled with esbuild  
**Backend:** Node.js + Express + Copilot SDK  
**Streaming:** Server-Sent Events (SSE)

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
├── ts/            # TypeScript source (bundled to bundle.js)
├── index.html     # Single-page app
└── style.css      # All styling

src/
├── server.ts      # Express server
├── session-manager.js  # Copilot session lifecycle
└── routes/        # API endpoints

doc/
└── API.md         # Complete API reference
```

## Documentation

See [doc/API.md](doc/API.md) for complete API reference including:
- HTTP endpoints (sessions, streaming, applets, files)
- MCP tools (set_applet_content, save_applet, display tools)
- JavaScript APIs for applet code (setAppletState, loadApplet, navigation)
- SSE events for response streaming
- File storage structure

## License

MIT