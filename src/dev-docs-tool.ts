/**
 * Caco Development Documentation Tool
 * 
 * Provides self-discovery for agents working on the Caco codebase.
 * Returns project structure, architecture overview, and pointers to docs.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DEV_DOCS = `# Caco Documentation

Caco is a self-extensible chat frontend for the GitHub Copilot CLI SDK.
**You are running inside Caco.**

## General Usage

For setup, usage, keyboard shortcuts, autostart on login, and user-facing features, read \`README.md\` at the project root. Key topics covered:
- Quick start and installation
- Autostart on Windows login (VBS wrapper in Startup folder)
- Session panel, applet browser, keyboard shortcuts
- User data locations (\`~/.caco/\`)

## Development Guide

You can modify Caco's source code, and changes take effect on restart.

## Project Root

The Caco source code is at the project's git root. Key paths:

| Path | Purpose |
|------|---------|
| \`server.ts\` | Express entry point, tool factory, middleware |
| \`src/\` | Server-side TypeScript (session management, routes, tools) |
| \`src/routes/\` | HTTP API and WebSocket handlers |
| \`public/ts/\` | Frontend TypeScript (bundled to public/bundle.js) |
| \`public/index.html\` | Single-page app HTML |
| \`public/style.css\` | All styling |
| \`code-quality.md\` | Code review principles |
| \`API.md\` | Complete API reference |
| \`APPLETS.md\` | Applet authoring guide |
| \`EXTENSIONS.md\` | Extensions and skills guide |
| \`tests/unit/\` | Vitest unit tests |
| \`applets/\` | Bundled applet definitions |

## Build & Test

| Command | Purpose |
|---------|---------|
| \`npm run build\` | Full pipeline: client + typecheck + lint + knip + test + scan |
| \`npm run build:client\` | Bundle frontend TypeScript → public/bundle.js |
| \`npm run typecheck\` | TypeScript check (server + frontend) |
| \`npm run lint:strict\` | ESLint with zero warnings |
| \`npm run test\` | Vitest unit tests |
| \`npm run knip\` | Dead export detection |

## Architecture

\`\`\`
Browser (localhost:53000)
    ↓ WebSocket + REST
Express Server (server.ts)
    ↓ Tool factory creates MCP tools per session
Session Manager (src/session-manager.ts)
    ↓ JSON-RPC
Copilot SDK → Copilot CLI → AI Models
\`\`\`

**Key modules:**
- \`session-manager.ts\` — SDK client lifecycle (create, resume, stop, send)
- \`session-state.ts\` — Active session tracking, preferences, multi-client support
- \`src/routes/session-messages.ts\` — Message dispatch with event streaming
- \`src/routes/websocket.ts\` — WS server, history replay, event broadcasting
- \`public/ts/message-streaming.ts\` — Frontend event handling and form state
- \`public/ts/dom-regions.ts\` — DOM ownership and event rendering

**Tool definitions:**
- \`src/agent-tools.ts\` — create_caco_session, send_caco_message, get_session_state
- \`src/applet-tools.ts\` — Applet CRUD, reload_page, restart_server
- \`src/display-tools.ts\` — embed_media
- \`src/mcp-auth-tools.ts\` — register_mcp_server
- \`src/extensions-tool.ts\` — caco_extensions (extension discovery + API guide)

**Extension system:**
- \`src/extension-store.ts\` — Discovery: scans ~/.caco/extensions/ + .caco/extensions/
- \`src/extension-runtime.ts\` — Server extension loading via jiti, ServerExtensionAPI
- \`public/ts/extension-api.ts\` — ClientExtensionAPI (UI slots, commands, shortcuts, #pound items)
- \`public/ts/extension-loader.ts\` — Dynamic import + hot-reload of client extensions
- Call \`caco_extensions\` tool for full API reference and extension authoring guide
- Spec: \`EXTENSIONS.md\`

## Making Changes

1. Edit server-side TypeScript in \`src/\` — use \`restart_server\` tool to apply
2. Edit frontend TypeScript in \`public/ts/\` — run \`npm run build:client\`, then \`reload_page\`
3. Edit HTML/CSS in \`public/\` — use \`reload_page\` tool to apply
4. Always run \`npm run test\` before committing
5. Read \`code-quality.md\` for review standards

## System Message

The agent system message is built in \`src/prompts.ts\` → \`buildSystemMessage()\`.
It includes applet discovery and is constructed at server startup.

## Documentation

Read \`API.md\` for the complete API reference, \`APPLETS.md\` for applet authoring, and \`EXTENSIONS.md\` for extensions and skills.

## Schedules

Recurring cron-based sessions for unattended automation. REST API:
- \`PUT /api/schedule/:slug\` — create/update. Body: \`{ "prompt": "...", "schedule": { "type": "cron", "expression": "0 9 * * *" }, "sessionConfig": { "model": "claude-sonnet", "persistSession": true } }\`
- \`GET /api/schedule\` — list all
- \`POST /api/schedule/:slug/run\` — trigger manually
- \`DELETE /api/schedule/:slug\` — remove

**Recommended scenarios:**
- Self-learning system prompts (weekly analysis of chat patterns → refine copilot-instructions.md)
- Automated server monitoring and diagnostics
- Weekly productivity summaries via session_store_sql history queries
- Daily planning digest from email/calendar via Gmail or Outlook MCP servers

See \`API.md\` for full schema details and \`README.md\` for examples.

## Copilot-CLI Configuration

Caco wraps the Copilot SDK which wraps Copilot-CLI. Help users configure:

| Feature | Location | Purpose |
|---------|----------|---------|
| System prompts | \`copilot-instructions.md\` in project root or \`~/.copilot/\` | Global or project-specific agent instructions |
| MCP servers | \`~/.copilot/mcp-config.json\` | External tool servers (databases, APIs). View via \`/?applet=mcp-servers\` |
| Skills | \`.copilot/skills/<name>/SKILL.md\` or \`~/.copilot/skills/\` | Reusable workflow definitions |
| Hooks | \`.copilot/hooks/\` | Shell scripts at lifecycle points (pre/post tool execution) |

Proactively suggest these when the user's workflow would benefit.
- API reference, WebSocket protocol, shell API
- Session management, state sync, context
- Session migration (export/import between machines) — see API.md "Session Migration" section
- Applet system, media embedding, scheduling
- Security model, agent recursion guards
`;

export function createDevDocsTool(projectRoot: string) {
  const cacoDevDocs = defineTool('caco_dev_docs', {
    description: `Get documentation for the Caco project. Call this when the user asks about Caco itself — how to use it, how to set it up, or how to modify it.

**When to call:**
- User asks about Caco usage, setup, autostart, or configuration
- User asks to change how Caco works (UI, tools, prompts, API)
- User asks about Caco's architecture or internals
- You need to find where a Caco feature is implemented
- You want to add a new tool, applet, or route to Caco

For general usage and setup, read \`README.md\` at the project root.`,

    parameters: z.object({
      section: z.string().optional().describe('Optional: "docs" to list all doc files, or omit for full dev guide')
    }),

    handler: async ({ section }) => {
      if (section === 'docs') {
        const rootDocs = ['README.md', 'API.md', 'APPLETS.md', 'EXTENSIONS.md', 'code-quality.md']
          .filter(f => existsSync(join(projectRoot, f)))
          .map(f => `- ${join(projectRoot, f)}`)
          .join('\n');

        // Scan doc/ subdirectories
        const docDir = join(projectRoot, 'doc');
        let subDocs = '';
        if (existsSync(docDir)) {
          const scanDir = (dir: string, prefix: string): string[] => {
            const results: string[] = [];
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                results.push(...scanDir(full, `${prefix}${entry.name}/`));
              } else if (entry.name.endsWith('.md')) {
                results.push(full);
              }
            }
            return results;
          };
          subDocs = scanDir(docDir, 'doc/')
            .map(f => `- ${f}`)
            .join('\n');
        }

        return {
          textResultForLlm: `# Documentation\n\nAll paths are absolute — use the view tool to read any file.\n\n## Root docs\n${rootDocs}\n\n## doc/ directory\n${subDocs}`
        };
      }

      return { textResultForLlm: DEV_DOCS };
    }
  });

  return [cacoDevDocs];
}
