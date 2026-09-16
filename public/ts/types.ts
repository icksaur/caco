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
  /** Set by the SDK on events originating from a sub-agent (task tool).
   *  Absent on primary-session events. Used to draw the agent discriminator. */
  agentId?: string;
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
  /** Persisted first-valid-intent fallback (spec-auto-name-sessions). Absent
   *  when the session has never emitted a valid intent. Truncated for display
   *  in the UI's title render, but sent untruncated on the wire so provenance
   *  checks (see `titleSource`) can compare against `currentIntent` cleanly. */
  autoName?: string | null;
  /** Which ladder level supplied the display title
   *  (spec-auto-name-sessions). The UI uses this to scope the sub-line
   *  suppression rule: only when `titleSource === 'auto-name'` AND
   *  `currentIntent === autoName` is the italicised sub-line hidden (to avoid
   *  rendering the same string twice). Every other value renders the sub-line
   *  as before. */
  titleSource?: 'name' | 'workspace-summary' | 'auto-name' | 'none';
  updatedAt?: string;
  isBusy?: boolean;
  isUnobserved?: boolean;
  currentIntent?: string;
  contextFiles?: string[];
  hasIcon?: boolean;
  scheduleSlug?: string;
  scheduleNextRun?: string;
  folder?: string;
  /** When a staged session becomes archivable (epoch ms), or null when it is not
   *  staged or nothing will reap it (spec-archive-staging). Derived from the same
   *  anchor the reaper uses, so it moves when the session is used. */
  archiveEligibleAt?: number | null;
  /** Herd bond: this session's parent id, or absent if not a herd child. */
  orchestratedBy?: string | null;
  /** Whether this session is a herd parent (≥1 child claims it). */
  isHerdParent?: boolean;
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
