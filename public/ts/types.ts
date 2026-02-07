/**
 * Client-side type definitions
 */

/**
 * SDK event structure
 * Used throughout the front-end for event handling
 */
export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  name: string;
  cost: number;
}

export interface SessionData {
  sessionId: string;
  cwd?: string;         // Working directory
  name?: string;        // Custom name from Caco storage
  summary?: string;     // SDK-generated summary
  updatedAt?: string;
  isBusy?: boolean;
  isUnobserved?: boolean;   // Has new activity since last viewed
  currentIntent?: string;   // What session is currently working on
  scheduleSlug?: string;    // If created by a schedule
  scheduleNextRun?: string; // Next scheduled run time
}

export interface SessionsResponse {
  activeSessionId: string;
  currentCwd: string;
  grouped: Record<string, SessionData[]>;
  models?: ModelInfo[];    // Models from SDK (if available)
  unobservedCount?: number; // Total sessions with unobserved activity
}

export interface Preferences {
  lastCwd?: string;
  lastModel?: string;
  lastSessionId?: string;
}

export interface DisplayOutput {
  id: string;
  // Type is optional - rendering is driven by metadata
  type?: string;
}

export interface ToolEventData {
  toolName?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
  result?: { content?: string | unknown };
  _output?: DisplayOutput;
}

export interface MessageEventData {
  content?: string;
  deltaContent?: string;
}

export interface OutputData {
  data: string;
  metadata: {
    // Common
    type?: string;
    
    // File/code metadata
    path?: string;
    startLine?: number;
    endLine?: number;
    totalLines?: number;
    highlight?: string;
    
    // Terminal metadata
    command?: string;
    exitCode?: number;
    
    // Image metadata
    mimeType?: string;
    
    // Embed metadata (html takes precedence over data)
    html?: string;
    provider?: string;
    providerKey?: string;
    title?: string;
    author?: string;
    url?: string;
    thumbnailUrl?: string;
  };
}
