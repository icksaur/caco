/**
 * Shared types for Caco
 */

export interface ModelInfo {
  id: string;
  name: string;
  cost: number;
}

export interface UserPreferences {
  lastCwd: string;
  lastModel: string;
  lastSessionId: string | null;
}

export interface SessionCacheEntry {
  cwd: string;
  summary: string | null;
  createdAt?: string;
  lastActiveAt?: string;
}

export interface ActiveSession {
  cwd: string;
  session: CopilotSession;
  client: CopilotClient;
}

export interface OutputEntry {
  content: string;
  language: string;
  createdAt: number;
}

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

export interface SystemMessage {
  mode: 'replace' | 'append';
  content: string;
}

export interface SessionConfig {
  model?: string;
  streaming?: boolean;
  systemMessage?: SystemMessage;
  toolFactory?: ToolFactory;
  excludedTools?: string[];
}

export interface CreateConfig {
  model?: string;
  systemMessage?: SystemMessage;
  toolFactory: ToolFactory;
  excludedTools?: string[];
}

export interface ResumeConfig {
  toolFactory: ToolFactory;
  excludedTools?: string[];
}

export interface SessionIdRef {
  id: string;
}

export type ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => unknown[];

export interface SessionStateConfig {
  systemMessage: SystemMessage;
  toolFactory: ToolFactory;
  excludedTools?: string[];
}

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
