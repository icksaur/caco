/**
 * Applet Tools
 * 
 * MCP tools for applet interaction and documentation.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getAppletUserState, getAppletNavigation, triggerReload } from './applet-state.js';
import { pushStateToApplet } from './routes/websocket.js';

/**
 * Documentation returned by applet_howto tool.
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

Plain JavaScript with global functions for onclick handlers:
\`\`\`javascript
function appendDigit(d) {
  document.getElementById('display').value += d;
}

function calculate() {
  const result = eval(document.getElementById('display').value);
  setAppletState({ lastResult: result });
}
\`\`\`

## JavaScript APIs

**Navigation:**
- \`loadApplet(slug)\` - Navigate to another applet
- \`listApplets()\` - Get array of saved applets (async)
- \`appletContainer\` - Reference to container element

**Agent Communication (two patterns):**

### Pattern 1: Passive State (agent polls)
\`setAppletState(obj)\` - Store state for agent to query later
\`\`\`javascript
setAppletState({ selectedFile: '/path/to/file.txt' });
// Agent can read this anytime via get_applet_state tool
\`\`\`

### Pattern 2: Active Request (agent responds NOW)
\`sendAgentMessage(prompt)\` - Send message, agent responds immediately
\`\`\`javascript
await sendAgentMessage('Get MSFT stock price and set_applet_state with result');
// Agent receives message, takes action, responds in chat
\`\`\`

**Use passive** when storing data for agent to read on demand.
**Use active** when you want the agent to do something RIGHT NOW.

## Tips

- Use onclick="functionName()" for button handlers (not addEventListener)
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
          : `Server restart initiated. This MUST be your final action.`,
        resultType: 'success' as const,
        toolTelemetry: {
          restartScheduled: true,
          activeDispatches: active,
          pid: process.pid
        }
      };
    }
  });

  const appletHowto = defineTool('applet_howto', {
    description: 'Get documentation for creating interactive applets. Call this when user asks to create an applet, widget, or interactive UI component.',

    parameters: z.object({}),

    handler: async () => {
      return {
        textResultForLlm: APPLET_HOWTO,
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

  return [appletHowto, getAppletState, setAppletState, reloadPage, restartServer];
}
