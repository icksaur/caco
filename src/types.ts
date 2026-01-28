/**
 * Shared types for copilot-web
 */

// Model configuration
export interface ModelInfo {
  id: string;
  name: string;
  cost: number;
}

// User preferences persisted to disk
export interface UserPreferences {
  lastCwd: string;
  lastModel: string;
  lastSessionId: string | null;
}

// Session cache entry (persisted)
export interface SessionCacheEntry {
  cwd: string;
  summary: string | null;
  createdAt?: string;
  lastActiveAt?: string;
}

// Active session tracking (in-memory)
export interface ActiveSession {
  cwd: string;
  session: CopilotSession;
  client: CopilotClient;
}

// Output cache entry
export interface OutputEntry {
  content: string;
  language: string;
  createdAt: number;
}

// Grouped sessions by cwd for UI
export interface GroupedSessions {
  [cwd: string]: SessionListItem[];
}

export interface SessionListItem {
  id: string;
  summary: string | null;
  age: string;
  isActive: boolean;
  lastActiveAt?: string;
}

// System message configuration
export interface SystemMessage {
  mode: 'replace' | 'append';
  content: string;
}

// Session creation config
export interface SessionConfig {
  model?: string;
  streaming?: boolean;
  systemMessage?: SystemMessage;
  toolFactory?: ToolFactory;
  excludedTools?: string[];
}

// Session ID reference - mutable for agent tools
export interface SessionIdRef {
  id: string;
}

// Tool factory - creates tools with session cwd and sessionId ref
// The ref allows updating sessionId after session creation for new sessions
export type ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => unknown[];

// Session config with tool factory (for init)
export interface SessionStateConfig {
  systemMessage: SystemMessage;
  toolFactory: ToolFactory;
  excludedTools: string[];
}

// API response types
export interface SessionResponse {
  sessionId: string | null;
  cwd: string;
  isActive: boolean;
  hasMessages: boolean;
}

export interface SessionsListResponse {
  activeSessionId: string | null;
  currentCwd: string;
  grouped: GroupedSessions;
}

// Copilot SDK types (minimal definitions for what we use)
export interface CopilotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(config: SessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config?: SessionConfig): Promise<CopilotSession>;
}

export interface CopilotSession {
  sessionId: string;
  send(options: SendOptions): AsyncIterable<SessionEvent>;
}

export interface SendOptions {
  prompt: string;
  attachments?: Attachment[];
  mode?: string;
}

export interface Attachment {
  type: 'file' | 'image';
  path: string;
}

export interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

// oEmbed types
export interface OEmbedProvider {
  name: string;
  patterns: RegExp[];
  endpoint: string;
  format?: string;
}

export interface OEmbedResponse {
  type: string;
  html?: string;
  title?: string;
  thumbnail_url?: string;
  provider_name?: string;
  [key: string]: unknown;
}

export interface OEmbedOptions {
  maxwidth?: number;
  maxheight?: number;
}
