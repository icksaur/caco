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
  summary?: string;
  updatedAt?: string;
  isBusy?: boolean;
}

export interface SessionsResponse {
  activeSessionId: string;
  currentCwd: string;
  grouped: Record<string, SessionData[]>;
  models?: ModelInfo[];  // Models from SDK (if available)
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
