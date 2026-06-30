# Microsoft Graph Integration for Caco

> Investigation: options for querying email and Teams messages from within Caco.

## Goal

Give Caco agents access to Microsoft Graph data — primarily email (Outlook) and Teams messages — so agents can triage, search, summarize, and act on communications. This competes with features in tools like ClawPilot/OpenClaw.

## The Challenge

Caco is a plain HTTP/WebSocket server with no authentication layer. Users access it via `localhost:53000` or devtunnel. Copilot CLI handles all AI authentication via GitHub. Microsoft Graph requires **separate OAuth** against Microsoft Entra ID (Azure AD) — different identity system, different tokens.

## Microsoft Graph Auth Requirements

1. **App Registration** — Register in [Entra admin center](https://entra.microsoft.com/). Gets an `appId` (client ID).
2. **Delegated Permissions** — For user-context access: `Mail.Read`, `Mail.Send`, `Chat.Read`, `ChannelMessage.Read.All`, `User.Read`, etc.
3. **OAuth 2.0 Flow** — User authenticates, app gets an access token. Token is a Bearer token sent on each Graph API call.
4. **Redirect URI** — OAuth callback URL. Must be registered in the app registration.
5. **Token Refresh** — Access tokens expire (typically 1 hour). Refresh tokens needed for long-lived access.

## Options

### Option A: MCP Server (Recommended)

Build a standalone MCP server that handles Graph OAuth and exposes tools.

**How it works:**
- A small Node.js MCP server (stdio) registered in `~/.copilot/mcp.json`
- Server holds the Entra app registration `appId` and handles the OAuth device code flow or localhost redirect flow
- Tokens stored in `~/.caco/graph-auth.json` (encrypted or at-rest)
- Exposes MCP tools: `search_email`, `read_email`, `list_teams_messages`, `send_email`, etc.
- Copilot CLI discovers and invokes the tools — Caco doesn't need to know about Graph auth at all

**Pros:**
- Caco stays auth-free — all complexity is in the MCP server
- Works with any Copilot CLI client, not just Caco
- MCP servers already have an established pattern (see existing MCP tools like WorkIQ)
- Token storage isolated from Caco's session data
- Can be published and shared independently

**Cons:**
- Separate process to manage (though MCP servers auto-start)
- OAuth flow needs a one-time user interaction (device code or browser redirect)

**Auth flow options for the MCP server:**

1. **Device Code Flow** — Server prints a URL and code to stderr. User opens browser, enters code, signs in. No redirect URI needed. Best for CLI tools.
   ```
   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode
   Body: client_id=<appId>&scope=Mail.Read Chat.Read offline_access
   ```
   User sees: "To sign in, open https://microsoft.com/devicelogin and enter code ABCD1234"

2. **Localhost Redirect** — Server opens browser to auth URL with `redirect_uri=http://localhost:<port>/callback`. Catches the callback, exchanges code for token. More seamless but needs a free port.

3. **Caco-hosted callback** — Reuse Caco's MCP OAuth infrastructure (`/api/mcp/auth/callback`). The Graph MCP server registers as an OAuth MCP server. Caco's existing auth applet handles the flow.

### Option B: Caco Extension with Direct Graph Calls

Build a Caco server extension that adds Graph API routes and tools.

**How it works:**
- Extension at `~/.caco/extensions/graph/server.ts`
- Adds custom tools via `ServerExtensionAPI.addTool()`
- Handles OAuth via device code flow or Caco-hosted browser redirect
- Stores tokens in `~/.caco/graph-auth.json`
- Tools appear alongside other Caco tools

**Pros:**
- No separate process — runs inside Caco
- Can use Caco's existing UI (applets) for auth flow
- Direct access to session context (CWD, session notes, etc.)

**Cons:**
- Caco-specific — doesn't work with plain Copilot CLI
- Extension API may not support all needed patterns (e.g., opening browser for auth)
- Tighter coupling — Graph auth failures affect Caco stability

### Option C: Existing WorkIQ MCP Tool

The WorkIQ MCP tool already provides `ask_work_iq` which queries Microsoft 365 Copilot for email, meetings, files, and M365 data.

**Pros:**
- Already available as an MCP tool
- No app registration or OAuth needed (uses M365 Copilot backend)
- Handles auth via its own EULA acceptance flow

**Cons:**
- Black box — can't control what it searches or how it formats results
- Requires M365 Copilot license
- No direct email actions (send, reply, forward)
- No fine-grained control (specific mailbox folders, date ranges, etc.)
- No Teams channel message access

### Option D: Outlook COM (Windows Only)

The existing `reply-to-email` skill uses Outlook COM automation.

**Pros:**
- No app registration needed
- No OAuth — uses local Outlook session
- Already partially implemented

**Cons:**
- Windows-only
- Requires Outlook desktop app running
- COM automation is fragile and slow
- No Teams access
- Not portable to Linux/Mac

## Recommendation

**Option A (MCP Server) is the clear winner.** It keeps Caco clean, works with any Copilot client, and follows the established MCP pattern. Auth option 1 (device code flow) is simplest for first implementation.

### Proposed MCP Server: `graph-mcp`

**App Registration:**
- Register in Entra admin center for the user's tenant
- Permissions: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Chat.Read`, `ChannelMessage.Read.All`, `User.Read`, `offline_access`
- Public client (no client secret) — mobile/desktop app classification
- Multi-tenant if desired, or single-tenant for internal use

**Tools:**

| Tool | Graph API | Description |
|------|-----------|-------------|
| `search_email` | `POST /search/query` | Full-text search across mailbox |
| `list_email` | `GET /me/mailFolders/{id}/messages` | List messages in a folder |
| `read_email` | `GET /me/messages/{id}` | Read a specific email with body |
| `send_email` | `POST /me/sendMail` | Send an email |
| `reply_email` | `POST /me/messages/{id}/reply` | Reply to an email |
| `list_teams_chats` | `GET /me/chats` | List Teams chats |
| `read_teams_chat` | `GET /me/chats/{id}/messages` | Read messages in a chat |
| `search_teams` | `POST /search/query` | Search Teams messages |
| `get_calendar` | `GET /me/calendarView` | Get calendar events |

**Token Management:**
- Device code flow for initial auth
- Refresh token stored in `~/.caco/graph-tokens.json`
- Auto-refresh on 401
- Token scoped to user — no admin consent required for delegated permissions

**Implementation outline:**
```
graph-mcp/
├── package.json
├── src/
│   ├── index.ts          # MCP server entry point (stdio)
│   ├── auth.ts           # Device code flow + token storage + refresh
│   ├── graph-client.ts   # HTTP client for Graph API with token injection
│   └── tools/
│       ├── email.ts      # search, list, read, send, reply
│       ├── teams.ts      # chats, messages, search
│       └── calendar.ts   # calendar view
└── README.md
```

**Registration in MCP config:**
```json
{
  "mcpServers": {
    "graph": {
      "type": "local",
      "command": "npx",
      "args": ["tsx", "~/.caco/mcp-servers/graph-mcp/src/index.ts"],
      "env": {
        "GRAPH_APP_ID": "<your-app-registration-id>",
        "GRAPH_TENANT_ID": "<your-tenant-id>"
      }
    }
  }
}
```

## ClawPilot / OpenClaw

OpenClaw is open source at [openclaw/openclaw](https://github.com/openclaw/openclaw) (367k stars). It's a personal AI assistant with a "Gateway" control plane that bridges messaging channels to an AI agent.

### Architecture

OpenClaw is fundamentally different from Caco:

| | OpenClaw | Caco |
|---|---|---|
| **Core concept** | Personal assistant on messaging channels | Dev-focused chat UI for Copilot SDK |
| **Channels** | 25+ messaging platforms as I/O | Browser only (+ portal iframes) |
| **Agent** | Multi-provider (OpenAI, Anthropic, etc.) | GitHub Copilot via SDK |
| **Gateway** | Always-on daemon (systemd/launchd) | On-demand server |
| **Skills** | ClawHub registry (8k+ skills) | Local `.github/skills/` |

### How OpenClaw Handles Teams

Microsoft Teams is a **channel** (bidirectional messaging bridge), not a data query tool. OpenClaw connects to Teams via the [Bot Framework](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/what-are-bots) — it registers as a Teams bot app, receives messages via webhook, and sends responses back.

This means:
- **You can chat with the agent via Teams** — send a DM to the bot, it responds
- **It does NOT query your mailbox or read your email** — it's a messaging bridge, not a Graph API client
- **It does NOT search Teams channels** — it receives messages addressed to the bot
- **No email integration exists** — there's a Gmail Pub/Sub automation doc but that's Google, not Outlook

### What OpenClaw's Teams Channel Actually Does

1. Register an Azure Bot resource + Teams app
2. Bot Framework sends webhook POSTs when someone messages the bot
3. OpenClaw Gateway receives inbound messages, routes to the agent
4. Agent responds, Gateway sends reply back via Bot Framework
5. Pairing/allowlist controls who can DM the bot

### What It Does NOT Do

- ❌ Read your Outlook inbox
- ❌ Search Teams channels/chats you're in
- ❌ Triage email
- ❌ Access Microsoft Graph user data
- ❌ Calendar awareness

### What This Means for Caco

OpenClaw's "Teams support" is apples-to-oranges with what we want. We want to **query** email and Teams data (read, search, triage). OpenClaw lets you **chat** with the agent via Teams.

Both are useful features, but they're different:

| Feature | OpenClaw | Caco (proposed) |
|---------|----------|-----------------|
| Chat with agent via Teams | ✅ (channel bridge) | Not planned |
| Read/search your email | ❌ | ✅ (Graph MCP server) |
| Search Teams conversations | ❌ | ✅ (Graph MCP server) |
| Triage communications | ❌ | ✅ (scheduled polling) |
| Send email on your behalf | ❌ | ✅ (with confirmation) |

**Caco's Graph MCP approach would give capabilities that OpenClaw doesn't have.** The competitive feature isn't "chat via Teams" — it's "agent can read and act on your communications."

## Next Steps

1. Register an Entra app with delegated permissions
2. Scaffold `graph-mcp` as a stdio MCP server
3. Implement device code auth flow
4. Start with `search_email` + `read_email` as first tools
5. Add to Caco's MCP config
6. Test end-to-end: agent searches email, reads message, summarizes

## Security Considerations

- Tokens stored on disk — consider at-rest encryption or OS keychain
- Delegated permissions only — no app-only access to other users' mailboxes
- `Mail.Send` is powerful — consider a confirmation tool pattern (agent proposes, user approves)
- MCP server runs as the user's process — same trust boundary as Copilot CLI
- No tokens pass through Caco's HTTP server
