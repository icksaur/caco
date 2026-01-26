/**
 * Session Parsing Utilities
 * 
 * Pure functions for parsing session data from disk files.
 * Extracted from SessionManager for testability.
 */

/**
 * Parsed session start event data
 */
export interface ParsedSessionStart {
  cwd: string | null;
}

/**
 * Parsed workspace.yaml data
 */
export interface ParsedWorkspace {
  summary: string | null;
}

/**
 * Parse the first line of events.jsonl to extract session start data.
 * Returns cwd if present, null otherwise.
 * 
 * @example
 * parseSessionStartEvent('{"type":"session.start","data":{"context":{"cwd":"/home/user"}}}')
 * // => { cwd: '/home/user' }
 */
export function parseSessionStartEvent(jsonLine: string | undefined): ParsedSessionStart {
  if (!jsonLine || jsonLine.trim() === '') {
    return { cwd: null };
  }
  
  try {
    const event = JSON.parse(jsonLine) as {
      type?: string;
      data?: { context?: { cwd?: string } };
    };
    
    if (event.type !== 'session.start') {
      return { cwd: null };
    }
    
    return {
      cwd: event.data?.context?.cwd ?? null
    };
  } catch {
    return { cwd: null };
  }
}

/**
 * Parse workspace.yaml content to extract summary.
 * Returns summary if present, null otherwise.
 * 
 * @example
 * parseWorkspaceYaml('summary: "Fix bug in parser"')
 * // => { summary: 'Fix bug in parser' }
 */
export function parseWorkspaceYaml(yamlContent: string | undefined): ParsedWorkspace {
  if (!yamlContent || yamlContent.trim() === '') {
    return { summary: null };
  }
  
  try {
    // Try multiline format first: summary: |
    const multilineMatch = yamlContent.match(/^summary:\s*\|\s*\n((?:[ \t]+.+\n?)+)/m);
    if (multilineMatch) {
      const lines = multilineMatch[1].split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      return { summary: lines.join(' ') };
    }
    
    // Simple single-line: summary: value (but not summary: |)
    const match = yamlContent.match(/^summary:\s*["']?([^|\n][^\n]*?)["']?\s*$/m);
    if (match) {
      return { summary: match[1].trim() };
    }
    
    return { summary: null };
  } catch {
    return { summary: null };
  }
}
