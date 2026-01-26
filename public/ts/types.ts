/**
 * Client-side type definitions
 */

export interface ModelInfo {
  id: string;
  name: string;
  cost: number;
}

export interface SessionData {
  sessionId: string;
  summary?: string;
  updatedAt?: string;
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
  type: 'file' | 'terminal' | 'image';
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
    path?: string;
    command?: string;
    startLine?: number;
    endLine?: number;
    totalLines?: number;
    highlight?: string;
    exitCode?: number;
    mimeType?: string;
  };
}
