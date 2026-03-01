/**
 * Extension Introspection Tool
 *
 * Lets the agent discover loaded extensions, their tools, and capabilities.
 * Follows the same pull-on-demand pattern as caco_applet_usage and caco_dev_docs.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getExtensionMetadata } from './extension-runtime.js';

export function createExtensionsTool() {
  const tool = defineTool('caco_extensions', {
    description: `Discover loaded extensions and the extension API. Call when:
- User asks about extensions or customization
- You need to know what extensions are installed
- User wants to create a new extension
- You want to find extension-provided tools or commands`,

    parameters: z.object({}),
    handler: async () => {
      const metadata = getExtensionMetadata();

      const guide = `# Caco Extensions

## Loaded Extensions
${metadata.length === 0 ? 'None.' : metadata.map(m =>
  `- **${m.slug}**${m.description ? ` — ${m.description}` : ''}
  Tools: ${m.tools.length ? m.tools.join(', ') : 'none'} | CSS: ${m.hasCSS} | Client: ${m.hasClient} | Server: ${m.hasServer}`
).join('\n')}

## Creating an Extension

Extensions live in \`~/.caco/extensions/<slug>/\` (user-global) or \`.caco/extensions/<slug>/\` (project-local).

Required file: \`manifest.json\`
\`\`\`json
{ "name": "My Extension", "description": "What it does", "provides": ["css", "client", "server"] }
\`\`\`

### CSS Theme (\`style.css\`)
Override CSS custom properties or add styles. Hot-reloads on save.

### Client Extension (\`client.ts\`)
\`\`\`typescript
import type { ClientExtensionAPI } from './types';
export default function(api: ClientExtensionAPI) {
  // UI slots
  api.footer.addLeft('status', () => 'Ready');
  api.header.addRight('btn', () => { const b = document.createElement('button'); b.textContent = '⚡'; return b; });

  // Slash commands (appear in / popup)
  api.registerCommand('deploy', { description: 'Deploy to staging', handler: () => { /* ... */ } });

  // Pound items (appear in # popup alongside project files)
  api.registerPoundItems(() => [
    { label: 'env:staging', description: 'Staging environment', value: '[env:staging]' },
    { label: 'env:prod', description: 'Production', value: '[env:prod]' },
  ]);

  // Keyboard shortcuts
  api.registerShortcut('ctrl+1', () => api.switchSession(0));

  // WS communication
  api.send('ext.myext.ping', { ts: Date.now() });
  api.on('ext.myext.pong', (e) => console.log(e));

  // Persistent state (localStorage)
  api.setState('count', (api.getState<number>('count') ?? 0) + 1);

  // Return dispose function for hot-reload cleanup
  return () => { /* cleanup */ };
}
\`\`\`

### Server Extension (\`server.ts\`)
\`\`\`typescript
import type { ServerExtensionAPI } from './types';
export default function(api: ServerExtensionAPI) {
  // HTTP routes (mounted at /ext/<slug>/)
  api.router.get('/status', (req, res) => res.json({ ok: true }));

  // Agent tools (available to all sessions)
  api.registerTool({ name: 'my_tool', description: '...', handler: async () => ({ textResultForLlm: 'done' }) });

  // WS messaging
  api.onClientMessage('ext.myext.ping', (ws, data) => {
    api.broadcast('ext.myext.pong', { received: true });
  });

  // Extension description (shown in caco_extensions output)
  api.setDescription('Detailed description of what this extension does');

  // Persistent state (JSON file in extension dir)
  api.setState('lastRun', new Date().toISOString());
}
\`\`\`

## API Reference

**ClientExtensionAPI**: footer.addLeft/addRight/update, header.addLeft/addRight, on, registerShortcut, switchSession, switchSessionById, send, getState, setState, toast, registerCommand, registerPoundItems

**ServerExtensionAPI**: router, registerTool, broadcast, broadcastToSession, onClientMessage, setDescription, getState, setState

## Discovery
- Project-local (\`.caco/extensions/\`) overrides user-global (\`~/.caco/extensions/\`) on slug collision
- Hot-reload: CSS and client changes broadcast automatically, server changes require restart
- Full spec: \`doc/extensibility.md\``;

      return { textResultForLlm: guide };
    },
  });
  return [tool];
}
