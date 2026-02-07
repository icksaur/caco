/**
 * Prompt Building - Consolidated module for all prompt construction.
 * 
 * This module handles all context injection into agent conversations:
 * - System message (session creation)
 * - Resume context (first message after resume)
 * - Message source prefixes (applet/agent/scheduler identification)
 * 
 * All prompt-related logic is centralized here for discoverability and maintainability.
 */

import { homedir } from 'os';
import { existsSync } from 'fs';
import { listApplets } from './applet-store.js';
import { getSessionMeta } from './storage.js';
import type { SystemMessage } from './types.js';

// ============================================================================
// Types
// ============================================================================

export type MessageSource = 'user' | 'applet' | 'agent' | 'scheduler';

export interface ParsedMessage {
  source: MessageSource;
  identifier?: string;  // applet slug, session id, or schedule slug
  cleanContent: string;
}

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
- **Current directory**: ${process.cwd()} (but not limited to this)

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

## Session Context
Track important files and resources for session continuity:
- \`set_relevant_context("files", [paths], "merge")\` - Mark files as relevant
- \`get_relevant_context()\` - Check what context is stored

**When to use:**
- Starting work on a spec, design doc, or notes file
- User explicitly asks you to remember a file
- Working with specific endpoints or ports

Context is shown to you on session resume, so you don't forget what you were working on.

## Behavior Guidelines
- Provide direct, helpful answers without unnecessary caveats
- Access any file or directory the user mentions - you have full permission
- Use markdown formatting for better readability
- Be concise unless detail is requested
- When asked to read or show files, just do it - don't ask for confirmation
- When users share media URLs, embed them directly`
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
// Message Source Prefixes
// ============================================================================

/**
 * Parse message source markers from content.
 * Pure function - no I/O, no side effects.
 * 
 * Messages can have source prefixes:
 * - [applet:slug] - from applet iframes
 * - [agent:sessionId] - from agent-to-agent tools
 * - [scheduler:slug] - from scheduled jobs
 * 
 * @param content - Raw message content, possibly with source prefix
 * @returns Parsed source, identifier, and clean content without prefix
 */
export function parseMessageSource(content: string): ParsedMessage {
  // Parse applet marker: [applet:slug]
  const appletMatch = content.match(/^\[applet:([^\]]+)\]\s*/);
  if (appletMatch) {
    return {
      source: 'applet',
      identifier: appletMatch[1],
      cleanContent: content.slice(appletMatch[0].length)
    };
  }
  
  // Parse agent marker: [agent:sessionId]
  const agentMatch = content.match(/^\[agent:([^\]]+)\]\s*/);
  if (agentMatch) {
    return {
      source: 'agent',
      identifier: agentMatch[1],
      cleanContent: content.slice(agentMatch[0].length)
    };
  }
  
  // Parse scheduler marker: [scheduler:slug]
  const schedulerMatch = content.match(/^\[scheduler:([^\]]+)\]\s*/);
  if (schedulerMatch) {
    return {
      source: 'scheduler',
      identifier: schedulerMatch[1],
      cleanContent: content.slice(schedulerMatch[0].length)
    };
  }
  
  return { source: 'user', cleanContent: content };
}

/**
 * Create a source prefix for a message.
 * Inverse of parseMessageSource.
 * 
 * @param source - The message source type
 * @param identifier - The identifier (slug or session id)
 * @param content - The message content
 * @returns Prefixed content string
 */
export function prefixMessageSource(
  source: MessageSource, 
  identifier: string, 
  content: string
): string {
  if (source === 'user') {
    return content;
  }
  return `[${source}:${identifier}] ${content}`;
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
