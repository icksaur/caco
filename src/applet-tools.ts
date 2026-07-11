/**
 * Applet Tools
 * 
 * MCP tools for applet interaction and documentation.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getAppletUserState, getAppletNavigation, getActiveAppletSlug } from './applet-state.js';
import type { StatePushHandler } from './event-bus.js';
import { listApplets, type AppletMeta } from './applet-store.js';
import { requestRestart, getActiveDispatches } from './restart-manager.js';
import type { SessionIdRef } from './types.js';

/**
 * Format applet metadata for agent consumption.
 * Returns a concise usage block with URL pattern and parameter info.
 */
export function formatAppletUsage(applet: AppletMeta & { paths: unknown }): string {
  const params = Object.entries(applet.params || {});
  const required = params.filter(([, v]) => v.required).map(([k, v]) => `${k} - ${v.description || ''}`);
  const optional = params.filter(([, v]) => !v.required).map(([k, v]) => `${k} - ${v.description || ''}`);
  
  // Build example URL params
  const urlParams = params.map(([k]) => `${k}=<${k}>`).join('&');
  const urlSuffix = urlParams ? `&${urlParams}` : '';
  
  const lines = [
    `## ${applet.slug}`,
    applet.agentUsage?.purpose || applet.description || applet.name,
    `Link: \`[${applet.name}](/?applet=${applet.slug}${urlSuffix})\``
  ];
  
  if (required.length) lines.push(`Required: ${required.join('; ')}`);
  if (optional.length) lines.push(`Optional: ${optional.join('; ')}`);
  
  // Add state schema info if available
  if (applet.stateSchema) {
    const getKeys = applet.stateSchema.get ? Object.keys(applet.stateSchema.get).join(', ') : null;
    const setKeys = applet.stateSchema.set ? Object.keys(applet.stateSchema.set).join(', ') : null;
    if (getKeys) lines.push(`State (get_applet_state): ${getKeys}`);
    if (setKeys) lines.push(`State (set_applet_state): ${setKeys}`);
  }
  
  return lines.join('\n');
}

/**
 * Documentation for creating applets, surfaced via caco_docs section="applets:create".
 * This teaches agents how to create applets using file tools.
 */
export const APPLET_HOWTO = `
# Creating Applets in Caco

Applets are interactive HTML/JS/CSS components stored on disk and loaded via URL.

## File Structure

\`\`\`
~/.caco/applets/<slug>/
├── meta.json      # Required: { name, description, slug, createdAt, updatedAt }
├── content.html   # Required: HTML content (no <html>/<body> wrapper)
├── script.js      # Optional: JavaScript code (entry point)
├── *.js           # Optional: additional JS files (concatenated alphabetically BEFORE script.js)
└── style.css      # Optional: CSS styles
\`\`\`

## Multi-file applets

If an applet's directory contains additional \`*.js\` files alongside
\`script.js\`, they are concatenated in alphabetical order and prepended
to \`script.js\` before injection. This lets large applets split helper
classes (e.g. \`diff-tab.js\`, \`markdown-tab.js\`) into separate source
files without a bundler. Files are loaded as a single \`<script>\` tag
inside the applet's IIFE wrapper; shared globals should be exposed via
a namespace like \`window.__myApplet\`. Avoid stray \`.js\` files in the
applet directory if you do NOT want them executed.

## Creating an Applet

1. Choose a slug (lowercase, hyphens: "my-calculator", "todo-list")
2. Create directory: \`~/.caco/applets/<slug>/\`
3. Write the 4 files using write_file tool
4. Share URL with user: http://localhost:3000/?applet=<slug>

## meta.json Format

\`\`\`json
{
  "name": "My Calculator",
  "description": "A simple calculator applet",
  "slug": "my-calculator",
  "createdAt": "2026-01-27T12:00:00.000Z",
  "updatedAt": "2026-01-27T12:00:00.000Z"
}
\`\`\`

## content.html

HTML fragment (no doctype, html, head, body tags).
Do NOT include a title/heading — the runtime displays the applet name automatically.
\`\`\`html
<div class="calculator">
  <input type="text" id="display" readonly>
  <div class="buttons">
    <button onclick="appendDigit('7')">7</button>
    <!-- ... -->
  </div>
</div>
\`\`\`

## script.js

Plain JavaScript - functions for onclick handlers must be exposed to window:
\`\`\`javascript
function appendDigit(d) {
  document.getElementById('display').value += d;
}

function calculate() {
  const result = eval(document.getElementById('display').value);
  setAppletState({ lastResult: result });
}

// IMPORTANT: Expose functions for onclick handlers
// Scripts are wrapped in IIFE, so functions aren't automatically global
expose({ appendDigit, calculate });
\`\`\`

**Warning — onclick Handler Gotcha:**

Scripts are wrapped in an IIFE for isolation. Functions **aren't automatically global**.

**For onclick handlers, you MUST expose functions:**
\`\`\`javascript
function myHandler() { console.log('clicked'); }
expose('myHandler', myHandler);  // Now onclick="myHandler()" works
\`\`\`

**Alternative: Use addEventListener (recommended, no exposure needed)**
\`\`\`javascript
document.getElementById('my-btn').addEventListener('click', () => {
  console.log('clicked');  // No window exposure required!
});
\`\`\`

## JavaScript APIs

> All functions are accessed via the \`appletAPI\` global object.
> Exception: \`expose\` and \`setAppletState\` also work as bare globals for convenience.

**Function Exposure (for onclick handlers):**
\`expose(name, fn)\` or \`expose({ fn1, fn2 })\` - Expose functions to global scope
\`\`\`javascript
function handleClick() { /* ... */ }
expose('handleClick', handleClick);  // Now onclick="handleClick()" works

// Or expose multiple:
expose({ handleClick, handleSubmit, handleCancel });
\`\`\`

**Navigation:**
- \`appletAPI.loadApplet(slug, urlParams?)\` - Navigate to another applet
- \`appletAPI.listApplets()\` - Get array of saved applets (async)
- \`appletAPI.getAppletSlug()\` - Get current applet slug from URL
- \`appletContainer\` - Reference to container element (closure-captured, available in callbacks)

**Utility helpers (use these — avoid reimplementing):**

> Timing: \`appletAPI.*\` is available inside event handlers, async callbacks, and any code that runs after applet initialization. At the applet script's top level the API may not yet be on \`window\` — inline the logic instead of calling an \`appletAPI\` helper eagerly.

- \`appletAPI.fetch(url, opts?)\` - fetch wrapper with 10s timeout and HTTP error handling. Throws on non-OK with server's error message.
- \`appletAPI.escapeHtml(str)\` - Escape & < > " ' for safe innerHTML insertion.
- \`appletAPI.toast(msg, { type, autoHideMs })\` - Show a toast notification. Type: 'info' | 'success' | 'error'.

**Agent Communication (two patterns):**

### Pattern 1: Passive State (agent polls)
\`appletAPI.setAppletState(obj)\` - Store state for agent to query later
\`\`\`javascript
appletAPI.setAppletState({ selectedFile: '/path/to/file.txt' });
// Agent can read this anytime via get_applet_state tool
\`\`\`

### Pattern 2: Active Request (agent responds NOW)
\`appletAPI.sendAgentMessage(prompt, options?)\` - Send message, agent responds immediately
\`\`\`javascript
await appletAPI.sendAgentMessage('Get MSFT stock price and set_applet_state with result');
// Agent receives message, takes action, responds in chat

// With image (direct submission - max 100KB):
const canvas = document.getElementById('canvas');
await appletAPI.sendAgentMessage('What is this drawing?', { 
  imageData: canvas.toDataURL('image/png') 
});
\`\`\`

**Use passive** when storing data for agent to read on demand.
**Use active** when you want the agent to do something RIGHT NOW.

**File Operations:**

\`appletAPI.saveTempFile(dataUrl, options?)\` - Save data to ~/.caco/tmp/ for agent viewing

> **For images:** Prefer \`sendAgentMessage\` with \`imageData\` option (direct submission).
> The temp-file pattern still works but requires agent to call \`view\` tool.

\`\`\`javascript
// Preferred for images (direct):
await appletAPI.sendAgentMessage('Analyze this', { imageData: canvas.toDataURL() });

// Alternative (indirect, requires view tool):
const { path } = await appletAPI.saveTempFile(canvas.toDataURL('image/png'));
await appletAPI.sendAgentMessage(\`Analyze image at \${path}\`);
\`\`\`

\`appletAPI.callFileApi(endpoint, params)\` - Call Caco's file/workspace HTTP endpoints (not MCP, no agent involvement)
\`\`\`javascript
// Read a file
const result = await appletAPI.callFileApi('read_file', { path: '/path/to/file.txt' });

// Write a file
await appletAPI.callFileApi('write_file', { 
  path: '/path/to/output.txt', 
  content: 'Hello world' 
});

// List directory
const files = await appletAPI.callFileApi('list_directory', { path: '/home/user' });
\`\`\`

(Legacy: \`appletAPI.callMCPTool\` is a deprecated alias of \`callFileApi\`.)

\`appletAPI.fetchWithRetry(url, init?, options?)\` - For flaky external APIs
\`\`\`javascript
const res = await appletAPI.fetchWithRetry(
  'https://api.example.com/data',
  { headers: { 'Authorization': 'Bearer ' + token } },
  { retries: 3, timeoutMs: 15000 }
);
const data = await res.json();
\`\`\`

**Shell Commands:**

\`fetch('/api/shell', ...)\` - Execute shell commands for developer tools
\`\`\`javascript
const result = await fetch('/api/shell', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    command: 'git',
    args: ['status', '--porcelain=v2'],
    cwd: '/path/to/repo'  // Optional working directory
  })
});
const { stdout, stderr, code } = await result.json();
\`\`\`

Returns: \`{ stdout, stderr, code }\` - exit code 0 = success

**URL Parameters:**

\`appletAPI.onUrlParamsChange(callback)\` - React to URL param changes (RECOMMENDED)
\`\`\`javascript
// Handles initial load AND navigation (back/forward, chat links)
appletAPI.onUrlParamsChange(function(params) {
  loadContent(params.path || '');
});
\`\`\`

\`appletAPI.getAppletUrlParams()\` - Get URL query params (excluding 'applet')
\`\`\`javascript
// URL: /?applet=my-applet&file=/path/to/file&mode=edit
const params = appletAPI.getAppletUrlParams();
// { file: '/path/to/file', mode: 'edit' }
\`\`\`

\`appletAPI.updateAppletUrlParam(key, value)\` - Update param without navigation (replaceState)
\`\`\`javascript
appletAPI.updateAppletUrlParam('file', '/new/path');  // No page reload
\`\`\`

\`appletAPI.navigateAppletUrlParam(key, value)\` - Update param with history entry (pushState)
\`\`\`javascript
appletAPI.navigateAppletUrlParam('file', '/new/path');  // Creates back button entry
\`\`\`

**Agent-Pushed State:**

\`appletAPI.onStateUpdate(callback)\` - Receive state pushed from agent via WebSocket
\`\`\`javascript
appletAPI.onStateUpdate((state) => {
  console.log('Agent pushed:', state);
  // Update UI based on agent-provided data
});
\`\`\`

**Session Info:**

\`appletAPI.getSessionId()\` - Get active chat session ID
\`\`\`javascript
const sessionId = appletAPI.getSessionId();
// Use for session-specific operations
\`\`\`

## Tips

- **For onclick handlers:** Use \`expose('functionName', functionName)\` to make functions globally accessible
- **Preferred:** Use \`addEventListener\` instead of onclick attributes (no exposure needed)
- Applet runs in sandboxed scope but has full DOM access
- Use relative paths for any fetch() calls to local APIs

## After Creating/Updating

Always provide a clickable link so the user can open the applet:

\`\`\`markdown
Open the applet: [Calculator](/?applet=calculator)
\`\`\`

The link uses relative URL format \`/?applet=slug\` which navigates without page refresh.
`.trim();

/**
 * Create applet tools
 * Returns an array of tool definitions to include in session creation.
 */
/**
 * Build the applet usage guide (URL patterns for linking users to panels),
 * optionally filtered to one slug. Surfaced via caco_docs section="applets:usage".
 */
export async function buildAppletUsage(slug?: string): Promise<string> {
  const allApplets = await listApplets();
  const visibleApplets = allApplets.filter(a => !a.deprecated);

  if (slug) {
    const deprecatedHit = allApplets.find(a => a.slug === slug && a.deprecated);
    if (deprecatedHit) {
      return `Applet "${slug}" is deprecated. Use "${deprecatedHit.replacedBy || 'files'}" instead.`;
    }
  }

  const filtered = slug
    ? visibleApplets.filter(a => a.slug === slug)
    : visibleApplets;

  if (filtered.length === 0) {
    return slug
      ? `Applet "${slug}" not found. Available: ${visibleApplets.map(a => a.slug).join(', ') || 'none'}`
      : 'No applets installed. Use caco_docs section="applets:create" to create one.';
  }

  const usage = filtered.map(formatAppletUsage).join('\n\n');
  return `# Applet Usage\n\nProvide markdown links to open applets for users.\n\n${usage}`;
}

export function createAppletTools(_programCwd: string, sessionRef: SessionIdRef | undefined, pushStateToApplet: StatePushHandler) {

  const getAppletState = defineTool('get_applet_state', {
    description: 'Query state pushed by applet JS via setAppletState(). Returns the running applet\'s user input, selections, or computed values. Call this only when a specific interactive task needs the applet the user is currently viewing — not routinely.',

    parameters: z.object({
      key: z.string().optional().describe('Optional: Get a specific key from the state object instead of the full state.')
    }),

    handler: async ({ key }) => {
      const sid = sessionRef?.id;
      const state = getAppletUserState(sid);
      const navigation = getAppletNavigation(sid);
      const activeSlug = getActiveAppletSlug(sid);
      
      const meta = {
        activeApplet: activeSlug,
        stack: navigation.stack,
        urlParams: navigation.urlParams
      };
      
      if (key) {
        const value = state[key];
        return {
          textResultForLlm: value !== undefined 
            ? `Applet state["${key}"]: ${JSON.stringify(value)}\n\nNavigation: ${JSON.stringify(meta)}`
            : `Key "${key}" not found in applet state. Available keys: ${Object.keys(state).join(', ') || '(none)'}\n\nNavigation: ${JSON.stringify(meta)}`,
          resultType: 'success' as const
        };
      }
      
      return {
        textResultForLlm: Object.keys(state).length > 0
          ? `Applet state: ${JSON.stringify(state, null, 2)}\n\nNavigation: ${JSON.stringify(meta)}`
          : `No applet state set.${activeSlug ? ` Active applet: ${activeSlug}` : ' No applet open.'}\n\nNavigation: ${JSON.stringify(meta)}`,
        resultType: 'success' as const
      };
    }
  });

  const restartServer = defineTool('restart_server', {
    description: 'Schedule a graceful server restart to apply backend code changes (waits for active sessions to finish). Use as the final action after modifying src/*.ts files.',

    parameters: z.object({
      delay: z.number()
        .min(1)
        .max(30)
        .default(3)
        .optional()
        .describe('Seconds to wait before restarting (1-30, default: 3)')
    }),

    handler: async () => {
      requestRestart();
      const active = getActiveDispatches();

      return {
        textResultForLlm: active > 0 
          ? `Server restart scheduled. Waiting for ${active} active session(s) to complete. Server will restart when your session and all others are idle.`
          : 'Server restart initiated. This MUST be your final action.',
        resultType: 'success' as const,
        toolTelemetry: {
          restartScheduled: true,
          activeDispatches: active,
          pid: process.pid
        }
      };
    }
  });

  const setAppletState = defineTool('set_applet_state', {
    description: 'Push state to the running applet via WebSocket; it receives updates via onStateUpdate(). Use for progress, computed results, or any data the applet should display.',

    parameters: z.object({
      data: z.record(z.string(), z.unknown()).describe('State object to push to the applet. Keys/values are merged with existing state.'),
      sessionId: z.string().optional().describe('Optional session ID. Broadcasts to all open applets if not provided.')
    }),

    handler: async ({ data, sessionId }) => {
      const stateData = data as Record<string, unknown>;
      
      // Push to client via WebSocket only
      // Applet is source of truth - it will call setAppletState() after processing
      const sent = pushStateToApplet(sessionId || null, stateData);
      
      if (sent) {
        return {
          textResultForLlm: `State pushed to applet: ${JSON.stringify(data)}`,
          resultType: 'success' as const
        };
      } else {
        return {
          textResultForLlm: 'No applet WebSocket connections available. The applet may not be open.',
          resultType: 'success' as const
        };
      }
    }
  });

  return [getAppletState, setAppletState, restartServer];
}
