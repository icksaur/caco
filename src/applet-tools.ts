/**
 * Applet Tools
 * 
 * MCP tools for setting and querying applet content.
 * These tools allow the agent to create dynamic UI in the applet view.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { setApplet, getApplet, getAppletUserState } from './applet-state.js';

/**
 * Create applet tools
 * Returns an array of tool definitions to include in session creation.
 */
export function createAppletTools() {
  
  const setAppletContent = defineTool('set_applet_content', {
    description: `Set the content of the applet view with HTML, JavaScript, and CSS.

USE THIS TOOL TO CREATE INTERACTIVE UI:
- Custom forms, editors, or data viewers
- File browsers, config editors, log viewers  
- Dashboards, charts, or visualizations
- Any interactive interface the user requests

The applet view is a dedicated panel where your HTML/JS/CSS runs directly.
The user interface auto-switches to show your applet when content is set.

JAVASCRIPT EXECUTION:
- Runs in global scope - function declarations are available to onclick handlers
- Full DOM access (document, getElementById, querySelector, etc.)
- Fetch API for HTTP requests (including to localhost)
- A global \`appletContainer\` variable points to the .applet-content element

STATE MANAGEMENT:
To make applet state queryable by you (via get_applet_state tool):
- Call setAppletState({ key: value, ... }) to push state to server
- Call it on user input, button clicks, or whenever state changes
- Example: setAppletState({ result: display.value, lastOp: currentOp })
- You can then use get_applet_state to read what the user has done

TIPS:
- Inline onclick="myFunc()" handlers work because JS runs in global scope
- Use getElementById/querySelector to find elements in your HTML
- Keep state in regular JS variables (they persist until applet is replaced)
- CSS classes should be unique to avoid conflicts with the host page
- The applet persists until replaced or cleared`,

    parameters: z.object({
      html: z.string().describe('HTML content for the applet body. Will be injected into .applet-content container.'),
      js: z.string().optional().describe('JavaScript to execute after HTML is inserted. Runs in global scope - function declarations work with onclick handlers.'),
      css: z.string().optional().describe('CSS styles to inject. Use unique class names to avoid conflicts with host page.'),
      title: z.string().optional().describe('Applet title for the UI header. Shows what this applet is for.')
    }),

    handler: async ({ html, js, css, title }) => {
      // Store applet content - SSE pipeline will push to client
      setApplet({ html, js, css, title });
      
      // Return confirmation to agent (minimal - content goes to UI via SSE)
      const parts = [
        `HTML: ${html.length} chars`,
        js ? `JS: ${js.length} chars` : null,
        css ? `CSS: ${css.length} chars` : null
      ].filter(Boolean);
      
      return {
        textResultForLlm: `Applet "${title || 'untitled'}" set. ${parts.join(', ')}. User interface switched to applet view.`,
        resultType: 'success' as const,
        toolTelemetry: {
          appletSet: true,
          title: title || null,
          htmlLength: html.length,
          jsLength: js?.length || 0,
          cssLength: css?.length || 0
        }
      };
    }
  });

  const getAppletState = defineTool('get_applet_state', {
    description: `Get the current state of the applet, as pushed by the applet's JavaScript.

USE THIS TOOL TO READ USER INPUT:
- Form values, selections, or text content
- Computed results or derived state
- Any data the applet has exposed via setAppletState()

IMPORTANT: The applet must call setAppletState({...}) to make data queryable.
When creating an applet, include code like:
  setAppletState({ inputValue: document.getElementById('input').value })
Call setAppletState whenever state changes (on input, button click, etc.)

RETURNS:
- The full state object if no key specified
- The value of a specific key if key is provided
- Empty object if applet hasn't called setAppletState yet`,

    parameters: z.object({
      key: z.string().optional().describe('Optional: Get a specific key from the state object instead of the full state.')
    }),

    handler: async ({ key }) => {
      const state = getAppletUserState();
      const applet = getApplet();
      
      if (key) {
        const value = state[key];
        return {
          textResultForLlm: value !== undefined 
            ? `Applet state["${key}"]: ${JSON.stringify(value)}`
            : `Key "${key}" not found in applet state. Available keys: ${Object.keys(state).join(', ') || '(none)'}`,
          resultType: 'success' as const
        };
      }
      
      return {
        textResultForLlm: Object.keys(state).length > 0
          ? `Applet state: ${JSON.stringify(state, null, 2)}`
          : `Applet state is empty. ${applet ? 'The applet has not called setAppletState() yet.' : 'No applet is currently loaded.'}`,
        resultType: 'success' as const
      };
    }
  });

  return [setAppletContent, getAppletState];
}
