/**
 * Applet Tools
 * 
 * MCP tools for setting and querying applet content.
 * These tools allow the agent to create dynamic UI in the applet view.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { spawn } from 'child_process';
import { setApplet, getApplet, getAppletUserState, getActiveSlug, setActiveSlug, getAppletNavigation, triggerReload } from './applet-state.js';
import { saveApplet as storeApplet, loadApplet as loadStoredApplet, listApplets as listStoredApplets, getAppletPaths } from './applet-store.js';

/**
 * Create applet tools
 * Returns an array of tool definitions to include in session creation.
 * @param programCwd - The program's working directory for applet storage
 */
export function createAppletTools(programCwd: string) {
  
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

AVAILABLE GLOBAL FUNCTIONS (call from your applet JS):

  setAppletState({ key: value, ... })
    Push state to server. You can then query it with get_applet_state tool.
    Call on user input, button clicks, or whenever state changes.

  loadApplet(slug, params?)
    Load and display a saved applet by slug. Use for applet browsers/launchers.
    Optional params object sets URL query params for the target applet.
    Returns a Promise.
    Examples:
      loadApplet('calculator')
      loadApplet('image-viewer', { file: '/path/to/photo.jpg' })

  listApplets()
    Get list of saved applets. Returns Promise<Array<{slug, name, description}>>.
    Use for building applet browsers.

  getAppletUrlParams()
    Get URL query params (excluding 'applet'). Use to read initial state.
    Example: const { file } = getAppletUrlParams();

  updateAppletUrlParam(key, value)
    Update a URL query param (uses replaceState, no history entry).
    Use to make current state shareable/bookmarkable.

  navigateBack()
    Pop current applet and return to previous in navigation stack.

  getBreadcrumbs()
    Get current navigation stack: Array<{slug, label}>.

HTTP ENDPOINTS (for fetch() in your applet JS):

  GET /api/file?path=relative/path
    Serve any file with correct Content-Type. Use for images, text, etc.
    Returns raw file content (not JSON). 404 if not found.
    Example: <img src="/api/file?path=photos/sunset.jpg">
    Example: fetch('/api/file?path=config.yaml').then(r => r.text())

  GET /api/files?path=dir
    List directory contents: { files: [{name, type, size, mtime}] }

  GET /api/applets
    List all saved applets: { applets: [{slug, name, description, paths}] }

  GET /api/applets/:slug
    Get applet content: { slug, title, html, js, css, meta }

  POST /api/applets/:slug/load
    Load applet + update server state: { ok, slug, title, html, js, css }

TIPS:
- Inline onclick="myFunc()" handlers work because JS runs in global scope
- Use getElementById/querySelector to find elements in your HTML
- Keep state in regular JS variables (they persist until applet is replaced)
- CSS classes should be unique to avoid conflicts with the host page
- The applet persists until replaced or cleared
- For images, use /api/file?path=... directly in <img src>`,

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
      const slug = getActiveSlug();
      const navigation = getAppletNavigation();
      
      // Build response with metadata
      const meta = {
        activeSlug: slug || null,
        appletTitle: applet?.title || null,
        hasApplet: !!applet,
        // Navigation context from client
        stack: navigation.stack,
        urlParams: navigation.urlParams
      };
      
      if (key) {
        const value = state[key];
        return {
          textResultForLlm: value !== undefined 
            ? `Applet state["${key}"]: ${JSON.stringify(value)}\n\nMetadata: ${JSON.stringify(meta)}`
            : `Key "${key}" not found in applet state. Available keys: ${Object.keys(state).join(', ') || '(none)'}\n\nMetadata: ${JSON.stringify(meta)}`,
          resultType: 'success' as const
        };
      }
      
      return {
        textResultForLlm: Object.keys(state).length > 0
          ? `Applet state: ${JSON.stringify(state, null, 2)}\n\nMetadata: ${JSON.stringify(meta)}`
          : `Applet state is empty. ${applet ? 'The applet has not called setAppletState() yet.' : 'No applet is currently loaded.'}\n\nMetadata: ${JSON.stringify(meta)}`,
        resultType: 'success' as const
      };
    }
  });

  // =====================================================
  // Phase 3: Persistence tools
  // =====================================================

  const saveApplet = defineTool('save_applet', {
    description: `Save the current applet to disk for later reuse.

WHEN TO USE:
- After creating an applet the user wants to keep
- To update an existing saved applet with changes

WHAT IT DOES:
- Saves HTML, JS, and CSS as separate files in .copilot-web/applets/<slug>/
- Creates meta.json with name and description
- Sets the active slug so get_applet_state shows it

SLUG RULES:
- Lowercase letters, numbers, and hyphens only
- Must start and end with alphanumeric
- Examples: "calculator", "data-viewer", "my-app-v2"

After saving, the applet files can be inspected/edited with standard file tools.`,

    parameters: z.object({
      slug: z.string().describe('URL-safe identifier for the applet. Lowercase, numbers, hyphens.'),
      name: z.string().describe('Human-readable name for display.'),
      description: z.string().optional().describe('Brief description of what the applet does.')
    }),

    handler: async ({ slug, name, description }) => {
      const applet = getApplet();
      
      if (!applet) {
        return {
          textResultForLlm: 'No applet is currently loaded. Use set_applet_content first.',
          resultType: 'error' as const
        };
      }
      
      try {
        const paths = await storeApplet(
          programCwd,
          slug,
          name,
          applet.html,
          applet.js,
          applet.css,
          description
        );
        
        // Update active slug
        setActiveSlug(slug);
        
        return {
          textResultForLlm: `Applet saved as "${name}" (slug: ${slug})

Files created:
- ${paths.html}
- ${paths.js}
- ${paths.css}
- ${paths.meta}

Use list_applets to see all saved applets.
Use load_applet("${slug}") to reload this applet later.
You can also edit the files directly with standard file tools.`,
          resultType: 'success' as const
        };
      } catch (error) {
        return {
          textResultForLlm: `Failed to save applet: ${error instanceof Error ? error.message : String(error)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const loadApplet = defineTool('load_applet', {
    description: `Load a saved applet from disk and display it.

WHEN TO USE:
- User asks to open/load a previously saved applet
- After listing applets with list_applets

WHAT IT DOES:
- Reads the applet files from .copilot-web/applets/<slug>/
- Sends content to the applet view (same as set_applet_content)
- Sets the active slug

TIP: Before loading, you can inspect/edit the applet files directly:
- content.html - the HTML content
- script.js - the JavaScript
- style.css - the CSS
- meta.json - name and description`,

    parameters: z.object({
      slug: z.string().describe('The slug of the applet to load.')
    }),

    handler: async ({ slug }) => {
      try {
        const stored = await loadStoredApplet(programCwd, slug);
        
        if (!stored) {
          const available = await listStoredApplets(programCwd);
          return {
            textResultForLlm: `Applet "${slug}" not found.${available.length > 0 
              ? ` Available applets: ${available.map(a => a.slug).join(', ')}`
              : ' No applets are saved yet.'}`,
            resultType: 'error' as const
          };
        }
        
        // Set the applet content (will push to client via SSE)
        setApplet({
          html: stored.html,
          js: stored.js,
          css: stored.css,
          title: stored.meta.name
        }, slug);
        
        return {
          textResultForLlm: `Loaded applet "${stored.meta.name}" (slug: ${slug})

The applet is now displayed in the applet view.
Use get_applet_state to check user interactions.`,
          resultType: 'success' as const,
          toolTelemetry: {
            appletSet: true,
            title: stored.meta.name,
            htmlLength: stored.html.length,
            jsLength: stored.js?.length || 0,
            cssLength: stored.css?.length || 0
          }
        };
      } catch (error) {
        return {
          textResultForLlm: `Failed to load applet: ${error instanceof Error ? error.message : String(error)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const listApplets = defineTool('list_applets', {
    description: `List all saved applets with their file paths.

WHEN TO USE:
- User asks what applets are available
- Before loading an applet to see options
- To find applet files for editing

RETURNS:
For each applet:
- slug, name, description
- File paths to content.html, script.js, style.css
- Created and updated timestamps

TIP: You can read/edit the applet files directly with standard file tools
before calling load_applet to display the modified version.`,

    parameters: z.object({}),

    handler: async () => {
      try {
        const applets = await listStoredApplets(programCwd);
        
        if (applets.length === 0) {
          return {
            textResultForLlm: `No applets saved yet.

To save an applet:
1. Create one with set_applet_content
2. Save it with save_applet`,
            resultType: 'success' as const
          };
        }
        
        // Structured output for programmatic access
        const structured = applets.map(a => ({
          slug: a.slug,
          name: a.name,
          description: a.description || null,
          files: {
            html: a.paths.html,
            js: a.paths.js,
            css: a.paths.css,
            meta: a.paths.meta
          },
          updatedAt: a.updatedAt
        }));
        
        // Text summary for LLM
        const lines = applets.map(a => {
          const desc = a.description ? ` - ${a.description}` : '';
          return `${a.slug}: "${a.name}"${desc}\n  → ${a.paths.html}`;
        });
        
        return {
          textResultForLlm: `Saved applets (${applets.length}):\n\n${lines.join('\n\n')}

Use load_applet(slug) to display one.
You can read/edit the files directly before loading.`,
          resultType: 'success' as const,
          structuredResult: structured
        };
      } catch (error) {
        return {
          textResultForLlm: `Failed to list applets: ${error instanceof Error ? error.message : String(error)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const reloadPage = defineTool('reload_page', {
    description: `Reload the browser page.

USE THIS WHEN:
- You've made changes to client-side files (HTML, CSS, JS)
- You need the user to see updated styles or scripts
- The page needs a fresh start after server-side changes

The page will reload immediately after this tool is called.`,

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
    description: `Schedule a server restart after a delay. THIS MUST BE YOUR FINAL ACTION.

USE THIS WHEN:
- You've modified server-side TypeScript files (src/*.ts)
- Changes to routes, tools, or server logic need to take effect
- You want to apply backend changes without manual intervention

HOW IT WORKS:
1. This tool schedules a restart after the specified delay (default: 3 seconds)
2. The current response completes normally
3. After the delay, the server process exits and restarts
4. The browser will reconnect automatically

⚠️ CRITICAL: This MUST be your last tool call. After calling this:
- Do NOT call any more tools
- Do NOT try to verify the restart worked
- Simply inform the user the restart is scheduled and end your response
- The agent session terminates when the server restarts

In dev mode (tsx watch), the server auto-restarts on file changes,
so this tool is mainly useful for production mode or forced restarts.`,

    parameters: z.object({
      delay: z.number()
        .min(1)
        .max(30)
        .default(3)
        .describe('Seconds to wait before restarting (1-30, default: 3)')
    }),

    handler: async ({ delay = 3 }) => {
      // Spawn a detached process that waits then sends SIGTERM
      // This allows the current response to complete
      const script = `
        sleep ${delay}
        kill -TERM ${process.pid}
      `;
      
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      
      return {
        textResultForLlm: `Server restart scheduled in ${delay} seconds. The current response will complete, then the server will restart. In dev mode (tsx watch), it will auto-restart. In production, ensure your process manager (systemd, pm2, etc.) restarts the process.`,
        resultType: 'success' as const,
        toolTelemetry: {
          restartScheduled: true,
          delaySeconds: delay,
          pid: process.pid
        }
      };
    }
  });

  return [setAppletContent, getAppletState, saveApplet, loadApplet, listApplets, reloadPage, restartServer];
}
