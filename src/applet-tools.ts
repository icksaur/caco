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
    description: `Create interactive UI in the applet panel with HTML/JS/CSS. JS runs in global scope with full DOM access. Use for forms, dashboards, file browsers, or any custom interface.`,

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
        textResultForLlm: `Applet "${title || 'untitled'}" set (${parts.join(', ')}). UI switched to applet view.

JS globals: setAppletState(obj), loadApplet(slug, params?), getAppletUrlParams(), navigateBack()
HTTP: GET /api/file?path=..., GET /api/files?path=..., GET /api/applets`,
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
    description: `Query state pushed by applet JS via setAppletState(). Returns user input, selections, or computed values from the running applet.`,

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
    description: `Save current applet to .copilot-web/applets/<slug>/ for later reuse. Creates HTML, JS, CSS, and meta.json files.`,

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
    description: `Load and display a saved applet by slug from .copilot-web/applets/.`,

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
    description: `List all saved applets with slugs, names, and file paths.`,

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
    description: `Reload the browser page to apply client-side file changes.`,

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
    description: `Schedule a server restart to apply backend code changes. Use as final action after modifying src/*.ts files.`,

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
        textResultForLlm: `Server restart scheduled in ${delay} seconds.

⚠️ CRITICAL: This MUST be your final action. Do NOT call any more tools.
Simply inform the user the restart is scheduled and end your response.
The server will terminate and the agent session will be lost.`,
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
