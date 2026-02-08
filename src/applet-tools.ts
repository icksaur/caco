/**
 * Applet Tools
 * 
 * MCP tools for applet interaction and documentation.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getAppletUserState, getAppletNavigation, triggerReload } from './applet-state.js';
import { pushStateToApplet } from './applet-push.js';
import { listApplets, type AppletMeta } from './applet-store.js';

/**
 * Format applet metadata for agent consumption.
 * Returns a concise usage block with URL pattern and parameter info.
 */
function formatAppletUsage(applet: AppletMeta & { paths: unknown }): string {
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
 * Documentation returned by caco_applet_howto tool.
 * This teaches agents how to create applets using file tools.
 */
const APPLET_HOWTO = `
# Creating Applets in Caco

Applets are interactive HTML/JS/CSS components stored on disk and loaded via URL.

## File Structure

\`\`\`
~/.caco/applets/<slug>/
├── meta.json      # Required: { name, description, slug, createdAt, updatedAt }
├── content.html   # Required: HTML content (no <html>/<body> wrapper)
├── script.js      # Optional: JavaScript code
└── style.css      # Optional: CSS styles
\`\`\`

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

HTML fragment (no doctype, html, head, body tags):
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

⚠️ **onclick Handler Gotcha:**

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

**Function Exposure (for onclick handlers):**
\`expose(name, fn)\` or \`expose({ fn1, fn2 })\` - Expose functions to global scope
\`\`\`javascript
function handleClick() { /* ... */ }
expose('handleClick', handleClick);  // Now onclick="handleClick()" works

// Or expose multiple:
expose({ handleClick, handleSubmit, handleCancel });
\`\`\`

**Navigation:**
- \`loadApplet(slug)\` - Navigate to another applet
- \`listApplets()\` - Get array of saved applets (async)
- \`getAppletSlug()\` - Get current applet slug from URL
- \`appletContainer\` - Reference to container element

**Agent Communication (two patterns):**

### Pattern 1: Passive State (agent polls)
\`setAppletState(obj)\` - Store state for agent to query later
\`\`\`javascript
setAppletState({ selectedFile: '/path/to/file.txt' });
// Agent can read this anytime via get_applet_state tool
\`\`\`

### Pattern 2: Active Request (agent responds NOW)
\`sendAgentMessage(prompt, options?)\` - Send message, agent responds immediately
\`\`\`javascript
await sendAgentMessage('Get MSFT stock price and set_applet_state with result');
// Agent receives message, takes action, responds in chat

// With image (direct submission - max 100KB):
const canvas = document.getElementById('canvas');
await sendAgentMessage('What is this drawing?', { 
  imageData: canvas.toDataURL('image/png') 
});
\`\`\`

**Use passive** when storing data for agent to read on demand.
**Use active** when you want the agent to do something RIGHT NOW.

**File Operations:**

\`saveTempFile(dataUrl, options?)\` - Save data to ~/.caco/tmp/ for agent viewing

> **For images:** Prefer \`sendAgentMessage\` with \`imageData\` option (direct submission).
> The temp-file pattern still works but requires agent to call \`view\` tool.

\`\`\`javascript
// Preferred for images (direct):
await sendAgentMessage('Analyze this', { imageData: canvas.toDataURL() });

// Alternative (indirect, requires view tool):
const { path } = await saveTempFile(canvas.toDataURL('image/png'));
await sendAgentMessage(\`Analyze image at \${path}\`);
\`\`\`

\`callMCPTool(toolName, params)\` - Call MCP tools for file operations
\`\`\`javascript
// Read a file
const result = await callMCPTool('read_file', { path: '/path/to/file.txt' });

// Write a file
await callMCPTool('write_file', { 
  path: '/path/to/output.txt', 
  content: 'Hello world' 
});

// List directory
const files = await callMCPTool('list_directory', { path: '/home/user' });
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

\`onUrlParamsChange(callback)\` - React to URL param changes (RECOMMENDED)
\`\`\`javascript
// Handles initial load AND navigation (back/forward, chat links)
appletAPI.onUrlParamsChange(function(params) {
  loadContent(params.path || '');
});
\`\`\`

\`getAppletUrlParams()\` - Get URL query params (excluding 'applet')
\`\`\`javascript
// URL: /?applet=my-applet&file=/path/to/file&mode=edit
const params = appletAPI.getAppletUrlParams();
// { file: '/path/to/file', mode: 'edit' }
\`\`\`

\`updateAppletUrlParam(key, value)\` - Update param without navigation (replaceState)
\`\`\`javascript
appletAPI.updateAppletUrlParam('file', '/new/path');  // No page reload
\`\`\`

\`navigateAppletUrlParam(key, value)\` - Update param with history entry (pushState)
\`\`\`javascript
appletAPI.navigateAppletUrlParam('file', '/new/path');  // Creates back button entry
\`\`\`

**Agent-Pushed State:**

\`onStateUpdate(callback)\` - Receive state pushed from agent via WebSocket
\`\`\`javascript
appletAPI.onStateUpdate((state) => {
  console.log('Agent pushed:', state);
  // Update UI based on agent-provided data
});
\`\`\`

**Session Info:**

\`getSessionId()\` - Get active chat session ID
\`\`\`javascript
const sessionId = appletAPI.getSessionId();
// Use for session-specific operations
\`\`\`

## Tips

- **For onclick handlers:** Use \`expose('functionName', functionName)\` to make functions globally accessible
- **Preferred:** Use \`addEventListener\` instead of onclick attributes (no exposure needed)
- Test with reload_page tool after file changes
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
export function createAppletTools(_programCwd: string) {

  const getAppletState = defineTool('get_applet_state', {
    description: 'Query state pushed by applet JS via setAppletState(). Returns user input, selections, or computed values from the running applet.',

    parameters: z.object({
      key: z.string().optional().describe('Optional: Get a specific key from the state object instead of the full state.')
    }),

    handler: async ({ key }) => {
      const state = getAppletUserState();
      const navigation = getAppletNavigation();
      
      const meta = {
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
          : `Applet state is empty. The applet may not have called setAppletState() yet.\n\nNavigation: ${JSON.stringify(meta)}`,
        resultType: 'success' as const
      };
    }
  });

  const reloadPage = defineTool('reload_page', {
    description: 'Reload the browser page to apply client-side file changes.',

    parameters: z.object({}),

    handler: async () => {
      triggerReload();
      
      return {
        textResultForLlm: 'Page reload signal sent. The browser will refresh.',
        resultType: 'success' as const,
        toolTelemetry: {
          reloadTriggered: true
        }
      };
    }
  });

  const restartServer = defineTool('restart_server', {
    description: 'Schedule a graceful server restart to apply backend code changes. Server waits for all active sessions to finish responding before restarting. Use as final action after modifying src/*.ts files.',

    parameters: z.object({
      delay: z.number()
        .min(1)
        .max(30)
        .default(3)
        .optional()
        .describe('Seconds to wait before restarting (1-30, default: 3)')
    }),

    handler: async () => {
      // Import dynamically to avoid circular dependency
      const { requestRestart, getActiveDispatches } = await import('./restart-manager.js');
      
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

  const cacoAppletHowto = defineTool('caco_applet_howto', {
    description: 'Get documentation for CREATING new applets (HTML/JS/CSS widgets). Call when user asks to build a custom dashboard, form, or interactive component. For USING existing applets, call caco_applet_usage instead.',

    parameters: z.object({}),

    handler: async () => {
      return {
        textResultForLlm: APPLET_HOWTO,
        resultType: 'success' as const
      };
    }
  });

  const cacoAppletUsage = defineTool('caco_applet_usage', {
    description: 'Get applet URL patterns for linking users to interactive panels. Returns markdown link examples for showing files, diffs, git status, images, etc. Call when you want to display content to the user via an applet.',

    parameters: z.object({
      slug: z.string().optional().describe('Filter to a specific applet by slug')
    }),

    handler: async ({ slug }) => {
      const applets = await listApplets();
      const filtered = slug 
        ? applets.filter(a => a.slug === slug)
        : applets;
      
      if (filtered.length === 0) {
        return {
          textResultForLlm: slug 
            ? `Applet "${slug}" not found. Available: ${applets.map(a => a.slug).join(', ') || 'none'}`
            : 'No applets installed. Use caco_applet_howto to create one.',
          resultType: 'success' as const
        };
      }
      
      const usage = filtered.map(formatAppletUsage).join('\n\n');
      return {
        textResultForLlm: `# Applet Usage\n\nProvide markdown links to open applets for users.\n\n${usage}`,
        resultType: 'success' as const
      };
    }
  });

  const setAppletState = defineTool('set_applet_state', {
    description: 'Push state to the running applet in real-time via WebSocket. The applet receives updates via onStateUpdate() callback. Use for progress updates, computed results, or any data the applet should display.',

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

  return [cacoAppletHowto, cacoAppletUsage, getAppletState, setAppletState, reloadPage, restartServer];
}
