/**
 * Prompt Building - Consolidated module for all prompt construction.
 * 
 * This module handles all context injection into agent conversations:
 * - System message (session creation)
 * - Resume context (first message after resume)
 * 
 * Message source prefixes live in message-source.ts (re-exported here
 * for backward compatibility).
 */

import { homedir } from 'os';
import { existsSync } from 'fs';
import { listApplets } from './applet-store.js';
import { getSessionMeta } from './storage.js';
import type { SystemMessage } from './types.js';

// Re-export message source types and functions for backward compatibility
export { parseMessageSource, prefixMessageSource } from './message-source.js';
export type { MessageSource, ParsedMessage } from './message-source.js';

// ============================================================================
// Types
// ============================================================================

export interface ResumeContextInput {
  cwd: string;
  envHint?: string;
  context?: Record<string, string[]>;
}

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

## Display Tools
You have a tool that displays content directly to the user:
- \`embed_media\` - Embed YouTube/SoundCloud/Vimeo/Spotify content

Use embed_media when users want to watch or listen to media inline.

## Applets
Interactive panels. Provide markdown links to open for users.
${appletPrompt}
Examples: \`[View file](/?applet=text-editor&path=/file)\` | \`[Git status](/?applet=git-status&path=/repo)\`
Call \`caco_applet_usage\` for all applet URL patterns. Call \`caco_applet_howto\` to create new applets.

## Agent-to-Agent Tools
You can communicate with other agent sessions:
- \`send_agent_message\` - Send a message to another session
- \`get_session_state\` - Check if a session is idle or streaming  
- \`create_agent_session\` - Create a new session with specific cwd

Use these to delegate subtasks, coordinate work, or fan out parallel tasks.
Include callback instructions so other agents can report back when finished.

## Session Context — REQUIRED
You MUST use \`set_relevant_context\` to track files and resources as you work. This is not optional — the user sees context updates in real-time and uses them to collaborate with you.

- \`set_relevant_context("files", [paths], "merge")\` - Track relevant files
- \`get_relevant_context()\` - Check stored context on resume

**You MUST call set_relevant_context when you:**
- Read or edit any file central to the task (specs, configs, source files)
- Start work involving a design doc, spec, or notes file
- Work with specific endpoints, ports, or applets
- Before finishing a task — save context for future sessions

Do NOT minimize these calls. Every relevant document should be tracked. The user's context footer updates live, enabling real-time collaboration.

## Behavior Guidelines
- Provide direct, helpful answers without unnecessary caveats
- Access any file or directory the user mentions - you have full permission
- Use markdown formatting for better readability
- Be concise unless detail is requested
- When asked to read or show files, just do it - don't ask for confirmation
- When users share media URLs, embed them directly
- Do not use emoji in responses. Use markdown formatting elements (headers, bold, lists, code) and basic unicode glyphs (arrows, dashes, bullets) instead`
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
// Resume Context
// ============================================================================

/**
 * Build context message to prepend on first send after resume.
 * Informs agent that shell state is reset and may need re-initialization.
 * 
 * @param input - cwd and optional envHint
 * @returns Context string to prepend to user message
 */
export function buildResumeContext(input: ResumeContextInput): string {
  const { cwd, envHint, context } = input;
  
  let result = `[SESSION RESUMED]
This is a resumed session. Your shell state has been reset.
Re-run any environment setup commands before proceeding.

Session directory: ${cwd}`;

  if (envHint) {
    result += `\nEnvironment hint: ${envHint}`;
  }
  
  // Add context sets
  if (context) {
    const contextLines = formatContextForResume(context, existsSync);
    if (contextLines) {
      result += `\n\n${contextLines}`;
    }
  }
  
  result += '\n---\n\n';
  return result;
}

/**
 * Format context sets for resume injection.
 * Pure function for testability.
 * @param context - Context sets to format
 * @param fileExists - Predicate to check file existence (injectable for testing)
 */
export function formatContextForResume(
  context: Record<string, string[]>,
  fileExists: (path: string) => boolean = () => true
): string {
  const parts: string[] = [];
  
  // Files - filter to existing only
  if (context.files?.length) {
    const existing = context.files.filter(f => fileExists(f));
    const missing = context.files.length - existing.length;
    if (existing.length) {
      let fileList = `Relevant files:\n${existing.map(f => `- ${f}`).join('\n')}`;
      if (missing > 0) {
        fileList += `\n(${missing} file(s) no longer exist)`;
      }
      parts.push(fileList);
    }
  }
  
  // Applet
  if (context.applet?.length) {
    const [slug, ...params] = context.applet;
    const paramStr = params.length ? ` (${params.join(', ')})` : '';
    parts.push(`Last applet: ${slug}${paramStr}`);
  }
  
  // Other sets - generic display
  for (const [name, items] of Object.entries(context)) {
    if (name === 'files' || name === 'applet') continue;
    if (items?.length) {
      parts.push(`${name}: ${items.join(', ')}`);
    }
  }
  
  return parts.join('\n\n');
}

/**
 * Build resume context for a specific session, reading envHint and context from meta.
 * Convenience wrapper that looks up session metadata.
 * 
 * @param sessionId - Session to build context for
 * @param cwd - Session working directory
 * @returns Context string to prepend
 */
export function buildResumeContextForSession(sessionId: string, cwd: string): string {
  const meta = getSessionMeta(sessionId);
  return buildResumeContext({ 
    cwd, 
    envHint: meta?.envHint,
    context: meta?.context
  });
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
