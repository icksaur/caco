/**
 * Applet Tools
 * 
 * MCP tools for applet interaction.
 * 
 * Removed tools (agent can use file tools directly):
 * - set_applet_content → Agent writes files, user navigates via URL
 * - save_applet → Agent uses write_file directly
 * - load_applet → User navigates via ?applet=slug URL
 * - list_applets → Agent uses list_dir on .copilot-web/applets/
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { spawn } from 'child_process';
import { getAppletUserState, getAppletNavigation, triggerReload } from './applet-state.js';

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
    description: 'Schedule a server restart to apply backend code changes. Use as final action after modifying src/*.ts files.',

    parameters: z.object({
      delay: z.number()
        .min(1)
        .max(30)
        .default(3)
        .describe('Seconds to wait before restarting (1-30, default: 3)')
    }),

    handler: async ({ delay = 3 }) => {
      const script = `sleep ${delay} && kill -TERM ${process.pid}`;
      
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      
      return {
        textResultForLlm: `Server restart scheduled in ${delay} seconds. This MUST be your final action.`,
        resultType: 'success' as const,
        toolTelemetry: {
          restartScheduled: true,
          delaySeconds: delay,
          pid: process.pid
        }
      };
    }
  });

  return [getAppletState, reloadPage, restartServer];
}
