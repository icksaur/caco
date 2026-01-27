# Copilot Web

A self-extensible chat front-end for the [GitHub Copilot CLI SDK](https://github.com/github/copilot-sdk).

## What is this?

A local web interface for Copilot that the agent can extend at runtime. The agent can create custom interactive applets in the browser—file browsers, dashboards, forms—without modifying the codebase.

**Key capabilities:**
- Chat interface with streaming responses
- Session management (multiple conversations)
- Image attachments (paste to send)
- Agent-generated custom interfaces via MCP tools
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
├── applet.md      # Custom applet interface design
├── custom-tools.md    # MCP tool documentation
└── ...            # Feature documentation
```

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/message` | POST | Send message, returns stream ID |
| `/api/stream/:id` | GET | SSE stream for responses |
| `/api/sessions` | GET | List chat sessions |
| `/api/sessions/:id/resume` | POST | Resume a session |
| `/api/history` | GET | Current session history |

## Documentation

See `doc/` for detailed documentation:
- [SDK Features](doc/sdk-features.md)
- [Custom Tools](doc/custom-tools.md)
- [Applet Interface](doc/applet.md)
- [Session Management](doc/session-management.md)
- [Streaming](doc/streaming.md)

## License

MIT