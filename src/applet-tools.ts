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

JAVASCRIPT CAPABILITIES:
- Full DOM access within #appletView container
- Fetch API for HTTP requests (including to localhost)
- Event handlers for user interaction
- Local state management

TIPS:
- Keep HTML semantic and accessible
- Use inline styles or the css parameter for styling
- JavaScript runs after HTML is injected
- The applet persists until replaced or cleared`,

    parameters: z.object({
      html: z.string().describe('HTML content for the applet body. Will be injected into #appletView container.'),
      js: z.string().optional().describe('JavaScript to execute after HTML is inserted. Runs in global scope with DOM access.'),
      css: z.string().optional().describe('CSS styles to inject. Scoped styles recommended (use classes/IDs).'),
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
