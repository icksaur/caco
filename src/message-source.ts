/**
 * Message Source Prefixes
 * 
 * Messages can have source prefixes to identify their origin:
 * - [applet:slug] - from applet iframes
 * - [agent:sessionId] - from agent-to-agent tools
 * - [scheduler:slug] - from scheduled jobs
 * - [skill:name] - from a skill slash-command invocation (shown purple)
 * - [system:id] - server-injected (e.g. autocontinue); id drives rendering
 * 
 * Pure functions - no I/O, no side effects.
 */

export type MessageSource = 'user' | 'applet' | 'agent' | 'scheduler' | 'skill' | 'system';

export interface ParsedMessage {
  source: MessageSource;
  identifier?: string;  // applet slug, session id, or schedule slug
  cleanContent: string;
}

/**
 * Parse message source markers from content.
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
  
  // Parse skill marker: [skill:name]
  const skillMatch = content.match(/^\[skill:([^\]]+)\]\s*/);
  if (skillMatch) {
    return {
      source: 'skill',
      identifier: skillMatch[1],
      cleanContent: content.slice(skillMatch[0].length)
    };
  }

  // Parse system marker: [system:identifier] (server-injected, e.g. autocontinue)
  const systemMatch = content.match(/^\[system:([^\]]+)\]\s*/);
  if (systemMatch) {
    return {
      source: 'system',
      identifier: systemMatch[1],
      cleanContent: content.slice(systemMatch[0].length)
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
