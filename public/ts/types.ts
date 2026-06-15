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
  priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  category?: 'lightweight' | 'versatile' | 'powerful';
  inputPerMtok?: number;
  outputPerMtok?: number;
  cachePerMtok?: number;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export type SessionKind = 'interactive' | 'agent' | 'swarm' | 'scheduled';

export interface SessionData {
  sessionId: string;
  cwd?: string;
  model?: string;
  name?: string;
  kind?: SessionKind;
  summary?: string;
  updatedAt?: string;
  isBusy?: boolean;
  isUnobserved?: boolean;
  currentIntent?: string;
  contextFiles?: string[];
  hasIcon?: boolean;
  scheduleSlug?: string;
  scheduleNextRun?: string;
  folder?: string;
}

export interface SessionsResponse {
  activeSessionId: string;
  currentCwd: string;
  sessions: SessionData[];
  grouped?: Record<string, SessionData[]>;  // deprecated, peer compat
  sessionOrder?: string[];   // MRU snapshot order (session IDs)
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

/**
 * Window extensions for Caco app
 * Single source of truth - other files should not redeclare these
 */
declare global {
  interface Window {
    renderMarkdown?: () => Promise<void>;
    renderMarkdownElement?: (element: Element) => void;
  }
}
