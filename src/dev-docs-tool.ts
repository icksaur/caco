/**
 * Caco Development Documentation Tool
 * 
 * Provides self-discovery for agents working on the Caco codebase.
 * Returns project structure, architecture overview, and pointers to docs.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { APPLET_HOWTO, buildAppletUsage } from './applet-tools.js';
import { buildExtensionsGuide } from './extensions-tool.js';

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
- \`src/agent-tools.ts\` — create_caco_session, get_session_state
- \`src/applet-tools.ts\` — Applet CRUD, restart_server
- \`src/mcp-auth-tools.ts\` — register_mcp_server
- \`src/extensions-tool.ts\` — extensions guide (caco_docs section="extensions")

**Extension system:**
- \`src/extension-store.ts\` — Discovery: scans ~/.caco/extensions/ + .caco/extensions/
- \`src/extension-runtime.ts\` — Server extension loading via jiti, ServerExtensionAPI
- \`public/ts/extension-api.ts\` — ClientExtensionAPI (UI slots, commands, shortcuts, #pound items)
- \`public/ts/extension-loader.ts\` — Dynamic import + hot-reload of client extensions
- Call \`caco_docs section="extensions"\` for full API reference and extension authoring guide
- Spec: \`EXTENSIONS.md\`

## Making Changes

1. Edit server-side TypeScript in \`src/\` — use \`restart_server\` tool to apply
2. Edit frontend TypeScript in \`public/ts/\` — run \`npm run build:client\`, then refresh the browser
3. Edit \`public/style.css\` — refresh the browser to apply. **Editing \`public/index.html\` requires \`restart_server\`** (it is read and hostname-injected once at startup, so a refresh alone serves the cached copy)
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

export function createDocsTool(projectRoot: string) {
  const cacoDocs = defineTool('caco_docs', {
    description: `Get documentation for the Caco project and its tools — usage, setup, autostart, configuration, architecture/internals, how to modify it (add a tool/applet/route, find where a feature lives), plus applet and extension authoring.

Sections:
- omit \`section\` for the full dev guide
- \`section: "index"\` lists all doc files (root + docs/)
- \`section: "<filename>"\` reads a doc by name (e.g. \`"session-surface-applet"\`, \`"surface-cookbook"\`, \`"API"\`, \`"APPLETS"\`). The .md extension is added automatically; root and \`docs/\` are searched.
- \`section: "applets:create"\` — how to CREATE applets (HTML/JS/CSS widgets).
- \`section: "applets:usage"\` — applet URL patterns for linking users to panels; pass \`slug\` to filter to one applet.
- \`section: "extensions"\` — loaded extensions + the extension API.

A named file section's response begins with a heading TOC (H2/H3 with line numbers); use \`viewRange: [startLine, endLine]\` to paginate (1-indexed, inclusive, mirrors the \`view\` tool). For general usage/setup, read \`README.md\`.`,

    parameters: z.object({
      section: z.string().optional().describe('Optional: "index" lists all doc files; "applets:create" / "applets:usage" / "extensions" are virtual sections; a filename (with or without .md) reads that doc. Omit for the full dev guide.'),
      slug: z.string().optional().describe('Only for section="applets:usage": filter to one applet by slug.'),
      viewRange: z.array(z.number()).length(2).optional().describe('Optional [startLine, endLine] (1-indexed, inclusive). Only meaningful with section=<filename>. Mirrors the view tool.')
    }),

    handler: async ({ section, slug, viewRange }) => {
      if (section === 'applets:create') {
        return { textResultForLlm: APPLET_HOWTO };
      }
      if (section === 'applets:usage') {
        return { textResultForLlm: await buildAppletUsage(slug) };
      }
      if (section === 'extensions') {
        return { textResultForLlm: buildExtensionsGuide() };
      }
      const rootCandidates = ['README.md', 'API.md', 'APPLETS.md', 'EXTENSIONS.md', 'code-quality.md'];
      const docsDir = join(projectRoot, 'docs');

      const scanDocs = (): string[] => {
        if (!existsSync(docsDir)) return [];
        const results: string[] = [];
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.md')) results.push(full);
          }
        };
        walk(docsDir);
        return results;
      };

      if (section === 'index') {
        const rootDocs = rootCandidates
          .filter(f => existsSync(join(projectRoot, f)))
          .map(f => `- ${join(projectRoot, f)}`)
          .join('\n');
        const subDocs = scanDocs().map(f => `- ${f}`).join('\n');
        return {
          textResultForLlm: `# Documentation Index\n\nAll paths are absolute. Read directly with the view tool, or call caco_docs with section="<basename>" to fetch by short name.\n\n## Root docs\n${rootDocs || '(none)'}\n\n## docs/ directory\n${subDocs || '(none)'}`
        };
      }

      if (section && section !== 'docs') {
        const cleaned = section.endsWith('.md') ? section : section + '.md';
        const candidates = [
          join(projectRoot, cleaned),
          join(docsDir, cleaned),
        ];
        // Fall back to a recursive basename match so docs in docs/ subdirs
        // (guides/, research/, archive/) are still fetchable by short name.
        if (!candidates.some(p => existsSync(p))) {
          const base = cleaned.toLowerCase();
          const hit = scanDocs().find(f => f.toLowerCase().endsWith('/' + base) || f.toLowerCase().endsWith('\\' + base));
          if (hit) candidates.push(hit);
        }
        for (const path of candidates) {
          if (existsSync(path)) {
            try {
              const body = readFileSync(path, 'utf-8');
              const lines = body.split('\n');
              const tocLines: string[] = [];
              for (let i = 0; i < lines.length; i++) {
                const m = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[i]);
                if (m) tocLines.push(`- L${i + 1}: ${m[1]} ${m[2]}`);
              }
              const tocBlock = tocLines.length > 0
                ? `\n## Headings (line numbers)\n${tocLines.join('\n')}\n`
                : '';
              if (viewRange) {
                const [startRaw, endRaw] = viewRange;
                const start = Math.max(1, Math.floor(startRaw));
                const end = Math.min(lines.length, Math.max(start, Math.floor(endRaw)));
                const slice = lines.slice(start - 1, end).join('\n');
                return {
                  textResultForLlm: `# ${path}\n${tocBlock}\n## Lines ${start}–${end} of ${lines.length}\n\n${slice}`
                };
              }
              return {
                textResultForLlm: `# ${path}\n${tocBlock}\n## Body (${lines.length} lines)\n\n${body}`
              };
            } catch (err) {
              return { textResultForLlm: `Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
        }
        const available = [
          ...rootCandidates.filter(f => existsSync(join(projectRoot, f))),
          ...scanDocs().map(f => f.replace(projectRoot + '/', '')),
        ].join(', ');
        return { textResultForLlm: `Doc "${section}" not found. Tried: ${candidates.join(', ')}. Available: ${available}` };
      }

      // section === 'docs' kept for backward compatibility — same as 'index'.
      if (section === 'docs') {
        const rootDocs = rootCandidates
          .filter(f => existsSync(join(projectRoot, f)))
          .map(f => `- ${join(projectRoot, f)}`)
          .join('\n');
        const subDocs = scanDocs().map(f => `- ${f}`).join('\n');
        return {
          textResultForLlm: `# Documentation Index\n\n## Root docs\n${rootDocs}\n\n## docs/ directory\n${subDocs}`
        };
      }

      return { textResultForLlm: DEV_DOCS };
    }
  });

  return [cacoDocs];
}
