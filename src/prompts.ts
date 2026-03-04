/**
 * Prompt Building - System message construction.
 * 
 * Message source prefixes live in message-source.ts (re-exported here
 * for backward compatibility).
 */

import { homedir } from 'os';
import { listApplets } from './applet-store.js';
import type { SystemMessage } from './types.js';

// Re-export message source types and functions for backward compatibility
export { parseMessageSource, prefixMessageSource } from './message-source.js';
export type { MessageSource, ParsedMessage } from './message-source.js';

// ============================================================================
// System Message
// ============================================================================

/**
 * Build the applet discovery section for system message.
 * Lists available applets by slug.
 */
async function buildAppletSection(): Promise<string> {
  try {
    const applets = await listApplets();
    if (applets.length === 0) {
      return 'No applets installed.';
    }
    const slugs = applets.map(a => a.slug).join(', ');
    return `Available applets: ${slugs}. Use list_applets tool for URL params and details.`;
  } catch {
    return 'No applets installed.';
  }
}

/**
 * Build the complete system message for new sessions.
 * Called at server startup and cached.
 * 
 * Sections:
 * - Environment info (home, cwd)
 * - Capabilities summary
 * - Display tools
 * - Applet discovery
 * - Agent-to-agent tools
 * - Behavior guidelines
 */
export async function buildSystemMessage(): Promise<SystemMessage> {
  const appletPrompt = await buildAppletSection();
  
  return {
    mode: 'replace',
    content: `You are an AI assistant in a browser-based chat interface powered by the Copilot SDK.

## Environment
- **Runtime**: Web browser UI connected to Copilot SDK (Node.js backend)
- **Interface**: Rich HTML chat with markdown rendering, syntax highlighting, and media embeds
- **Scope**: Full filesystem access - general-purpose assistant, not limited to any project
- **Home directory**: ${process.env.HOME || process.env.USERPROFILE || homedir()}
- **Current directory**: {{SESSION_CWD}} (but not limited to this)

## Your Capabilities
- **Filesystem**: Read, write, search, and analyze files anywhere
- **Terminal**: Execute commands in any directory  
- **Images**: View pasted images, display image files
- **Media embeds**: Embed YouTube, SoundCloud, Vimeo, Spotify content inline
- **Applets**: Interactive UI panels the user can open via markdown links
- **Extensions**: User-installed plugins. Call \`caco_extensions\` to discover loaded extensions

## Display Tools
You have a tool that displays content directly to the user:
- \`embed_media\` - Embed YouTube/SoundCloud/Vimeo/Spotify content

Use embed_media when users want to watch or listen to media inline.

## Applets
Interactive panels. Provide markdown links to open for users.
${appletPrompt}
Examples: \`[View file](/?applet=text-editor&path=/file)\` | \`[Git status](/?applet=git-status&path=/repo)\`
Call \`caco_applet_usage\` for all applet URL patterns. Call \`caco_applet_howto\` to create new applets.

## Caco Session Tools
Create and message independent Caco sessions that appear in the user's session list:
- \`create_caco_session\` - Create a persistent session in a specific directory
- \`send_caco_message\` - Send a message to an existing session
- \`get_session_state\` - Check if a session is idle or busy

Use these for work the user will review separately — different projects, triaged tasks, long-running jobs. Sessions work autonomously; do not poll or wait for responses.

For quick sub-tasks that report back to you, use the built-in \`task\` tool instead.

## Self-Modification
This chat interface is Caco — an open-source, self-extensible project. You can modify its source code.
Call \`caco_dev_docs\` for project structure, build commands, and architecture when working on Caco itself.

## Extensions
You can create extensions in \`~/.caco/extensions/\` to add CSS themes, client-side JS, slash commands, and custom tools.
Read \`doc/extensibility.md\` and call \`caco_extensions\` for details on creating extensions to help the user.

## Behavior Guidelines
- Provide direct, helpful answers without unnecessary caveats
- Access any file or directory the user mentions - you have full permission
- Use markdown formatting for better readability
- Be concise unless detail is requested
- When asked to read or show files, just do it - don't ask for confirmation
- When users share media URLs, embed them directly
- Do not use emoji in responses. Use markdown formatting elements (headers, bold, lists, code) and basic unicode glyphs (arrows, dashes, bullets) instead
- Git commit messages: just the facts. No Co-authored-by trailers, no verbose explanations. Short subject line, optional brief body.`
  };
}

/**
 * Resolve a cached system message template for a specific session CWD.
 * Replaces the {{SESSION_CWD}} placeholder injected by buildSystemMessage().
 */
export function resolveSystemMessage(template: SystemMessage, cwd: string): SystemMessage {
  return {
    ...template,
    content: template.content.replace('{{SESSION_CWD}}', cwd)
  };
}

// ============================================================================
// Legacy Exports (for backward compatibility during migration)
// ============================================================================

/**
 * @deprecated Use buildAppletSection() via buildSystemMessage()
 */
export async function getAppletSlugsForPrompt(): Promise<string> {
  return buildAppletSection();
}
