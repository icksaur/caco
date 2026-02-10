/**
 * MCP Authentication Agent Tools
 * 
 * Tools for agent to register MCP servers requiring OAuth authentication.
 * When an MCP tool returns 401, the agent can use these tools to register
 * the server for interactive OAuth flow.
 * 
 * See: doc/mcp-oauth-auth.md
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getMcpAuth, setMcpAuth, type MCPAuthState } from './storage.js';
import { discoverOAuthMetadata } from './mcp-discovery.js';

/**
 * Create MCP authentication tools
 */
export function createMcpAuthTools() {
  
  const registerMcpServer = defineTool('register_mcp_server', {
    description: `Register an MCP server that requires OAuth authentication. 
    
Call this when an MCP tool returns 401 Unauthorized. This tool will:
1. Discover OAuth endpoints for the server
2. Register the server in the MCP auth store
3. Tell you to direct the user to authenticate

After calling this, tell the user: "Please authenticate [server name] by opening /?applet=mcp-auth"`,

    parameters: z.object({
      serverUrl: z.string().url().describe('The MCP server URL that returned 401'),
      serverId: z.string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens')
        .describe('Identifier for this server (e.g., "azure-graph", "github-enterprise")'),
      clientId: z.string().optional()
        .describe('OAuth client_id (Application ID) - required for Azure AD. Ask user if not known.'),
    }),

    handler: async ({ serverUrl, serverId, clientId }) => {
      try {
        // Check if server already registered
        const store = getMcpAuth();
        if (store.servers[serverId]) {
          // Server already exists - check if it needs auth
          const existing = store.servers[serverId];
          if (existing.needsAuth || existing.needsClientId) {
            return {
              textResultForLlm: `Server "${serverId}" is already registered but needs configuration. ` +
                (existing.needsClientId 
                  ? `It requires a client_id (OAuth Application ID). Ask the user for their Azure App Registration's Application ID, then call register_mcp_server again with the clientId parameter.`
                  : `Tell the user to authenticate by opening /?applet=mcp-auth`),
              resultType: 'text' as const
            };
          }
          return {
            textResultForLlm: `Server "${serverId}" is already authenticated. If you're getting 401 errors, the token may have expired. Tell the user to re-authenticate via /?applet=mcp-auth`,
            resultType: 'text' as const
          };
        }
        
        // Discover OAuth metadata
        let metadata;
        try {
          metadata = await discoverOAuthMetadata(serverUrl);
        } catch (discoveryError) {
          // Discovery failed - still register the server but with an error
          const errorMessage = discoveryError instanceof Error ? discoveryError.message : 'Discovery failed';
          
          const serverState: MCPAuthState = {
            url: serverUrl,
            authorizationEndpoint: '',
            tokenEndpoint: '',
            clientId: clientId || null,
            needsAuth: true,
            needsClientId: !clientId,
            error: errorMessage,
          };
          
          store.servers[serverId] = serverState;
          setMcpAuth(store);
          
          return {
            textResultForLlm: `Server "${serverId}" registered but OAuth discovery failed: ${errorMessage}. ` +
              `The server may require manual configuration. Ask the user to provide the OAuth authorization endpoint, token endpoint, and client_id.`,
            resultType: 'text' as const
          };
        }
        
        // Check if discovery provided a client_id
        const resolvedClientId = clientId || metadata.client_id || null;
        
        // Create server state
        const serverState: MCPAuthState = {
          url: serverUrl,
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          scopes: metadata.scopes_supported,
          clientId: resolvedClientId,
          needsAuth: true,
          needsClientId: !resolvedClientId,
        };
        
        // Save to store
        store.servers[serverId] = serverState;
        setMcpAuth(store);
        
        // Return appropriate message based on whether we have client_id
        if (!resolvedClientId) {
          return {
            textResultForLlm: `Server "${serverId}" registered but requires a client_id (OAuth Application ID). ` +
              `Ask the user: "What is the OAuth client_id (Application ID) for this server? ` +
              `For Azure AD, this is found in Azure Portal > App Registrations > Your App > Application (client) ID."`,
            resultType: 'text' as const
          };
        }
        
        return {
          textResultForLlm: `Server "${serverId}" registered for OAuth. ` +
            `Tell the user to authenticate by opening /?applet=mcp-auth ` +
            `or clicking this link: [MCP Authentication](/?applet=mcp-auth)`,
          resultType: 'text' as const
        };
        
      } catch (err) {
        return {
          textResultForLlm: `Error registering MCP server: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  return [registerMcpServer];
}
