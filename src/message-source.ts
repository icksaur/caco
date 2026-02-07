/**
 * Message source parsing - identifies who sent a message.
 * 
 * Messages can originate from:
 * - user: Direct user input via chat
 * - applet: Applet calling sendAgentMessage()
 * - agent: Another agent session via send_agent_message tool
 * - scheduler: Scheduled job execution
 * 
 * Source markers are prefixed to prompts for SDK persistence:
 * - [applet:slug] message
 * - [agent:sessionId] message
 * - [scheduler:slug] message
 */

export type MessageSource = 'user' | 'applet' | 'agent' | 'scheduler';

export interface ParsedMessage {
  source: MessageSource;
  identifier?: string;  // applet slug, session id, or schedule slug
  cleanContent: string;
}

/**
 * Parse message source markers from content.
 * Pure function - no I/O, no side effects.
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
