/**
 * Applet Tools
 * 
 * MCP tools for setting and querying applet content.
 * These tools allow the agent to create dynamic UI in the applet view.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { setApplet, getApplet } from './applet-state.js';

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

  return [setAppletContent];
}
