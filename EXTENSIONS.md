# Extensions, Skills & MCP

Caco supports three extension points: **extensions** (CSS/JS injected into the UI),
**skills** (markdown instructions for agents), and **MCP servers** (external tool providers).

## Extensions

Extensions are directories containing CSS and/or TypeScript that Caco loads at startup.
They live in two locations (project-local wins on slug collision):

```
~/.caco/extensions/<slug>/          # user-global
.caco/extensions/<slug>/            # project-local (higher priority)
```

### Extension Structure

Each extension directory must contain a `manifest.json`:

```json
{
  "name": "My Extension",
  "description": "Optional description",
  "provides": ["css", "client", "server"]
}
```

The `provides` array declares which files are present:

| Type     | File        | What it does                                    |
|----------|-------------|-------------------------------------------------|
| `css`    | `style.css` | CSS injected into the page (custom properties, themes) |
| `client` | `client.ts` | Browser-side JS with access to UI slots, events, shortcuts |
| `server` | `server.ts` | Server-side TS loaded via jiti (no compile step) |

### Creating an Extension

1. Create a directory: `mkdir -p ~/.caco/extensions/my-ext`
2. Add `manifest.json` with `name` and `provides`
3. Add the files declared in `provides`
4. Restart Caco (CSS/client changes hot-reload; server changes require restart)

### Server Extension API

Server extensions export a default function receiving a `ServerExtensionAPI`:

```typescript
export default function (api: ServerExtensionAPI) {
  api.router.get('/hello', (req, res) => res.json({ ok: true }));
  api.registerTool({ name: 'my_tool', description: '...', handler: () => {} });
  api.broadcast('event-type', { data: 1 });
  api.onClientMessage('ping', (ws, data) => { /* ... */ });
}
```

The router is mounted at `/ext/<slug>/`. Tools are merged into the SDK tool factory.

### File Watching

Caco watches extension directories. Changes to `style.css` or `client.ts` trigger
hot-reload via WebSocket broadcast. Changes to `server.ts` require a restart.

## Skills

Skills are markdown files that give agents specialized instructions. They are
automatically loaded and offered to agents as invocable capabilities.

### Skill Locations

| Location | Scope | Notes |
|----------|-------|-------|
| `~/.copilot/skills/<name>/SKILL.md` | User-global | Loaded by default |
| `.github/skills/<name>/SKILL.md` | Project | Bundled with the repo |

### Skill Format

Each skill is a directory containing `SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: Short description shown to the agent
---

Step-by-step instructions the agent follows when the skill is invoked.
```

### Configuration

In session config, `skillDirectories` overrides the default skill paths (include
`~/.copilot/skills` explicitly if you want both). Use `disabledSkills` to exclude
specific skills by name.

### Built-in Project Skills

Caco ships four project skills in `.github/skills/`:

- **create-spec** — develop spec documents in `doc/`
- **implement-spec** — implement changes from a spec's plan
- **review-spec** — review a spec document
- **overkill-review** — identify unnecessary complexity

## MCP Servers

MCP (Model Context Protocol) servers provide external tools to agents. Caco supports
MCP servers with optional OAuth authentication.

### OAuth Authentication Flow

When an MCP server requires OAuth (Azure AD, GitHub, etc.), Caco handles the browser
authentication flow:

1. **Discovery** — Caco probes the server for OAuth metadata via RFC 8414
   (`.well-known/oauth-authorization-server`), OpenID Connect, or `WWW-Authenticate` headers
2. **Configuration** — User provides a `clientId` via the `mcp-auth` applet
3. **Authorization** — PKCE-based OAuth flow through the browser
4. **Token storage** — Tokens saved to `~/.caco/mcp-auth.json`, reused across sessions

### Auth Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/mcp/auth/servers` | GET | List servers with auth status |
| `/api/mcp/auth/start?server=<id>` | GET | Initiate OAuth (redirects to provider) |
| `/api/mcp/auth/callback` | GET | OAuth callback handler |
| `/api/mcp/auth/config` | POST | Update server config (set client_id) |

### Token Storage

Per-server state (url, endpoints, clientId, tokens, expiry, auth status) is persisted
in `~/.caco/mcp-auth.json` and reused across sessions. See `MCPAuthState` in
`src/storage.ts` for the full schema.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/extension-store.ts` | Directory scanning, manifest parsing, priority resolution |
| `src/extension-runtime.ts` | Server extension loading via jiti, API implementation |
| `src/extensions-tool.ts` | Agent introspection of loaded extensions |
| `src/mcp-discovery.ts` | OAuth metadata discovery (RFC 8414, OIDC) |
| `src/routes/mcp-auth.ts` | OAuth start/callback, token exchange, PKCE |
| `src/storage.ts` | MCPAuthState interface, `mcp-auth.json` I/O |
