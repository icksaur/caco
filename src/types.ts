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
  /** Auto-continuation (spec-enable-tools-autocontinue): when a dispatch reveals
   *  tools via caco_enable_tools, Caco auto-sends one follow-up so the tools are
   *  usable. Default on; set false to require a manual message instead. */
  autoContinueEnabled?: boolean;
}

export interface SessionCacheEntry {
  cwd: string;
  summary: string | null;
  createdAt?: string;
  lastActiveAt?: string;
}

export interface OutputEntry {
  content: string;
  language: string;
  createdAt: number;
}


export interface SessionListItem {
  id: string;
  summary: string | null;
  age: string;
  isActive: boolean;
  lastActiveAt?: string;
  folder?: string;
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
  /** Open-Plugins directories for the new session (spec-plugin-directories). Absolute +
   *  already normalized by the caller (the create route owns validation + meta persistence). */
  pluginDirectories?: string[];
}

export interface ResumeConfig {
  toolFactory: ToolFactory;
  excludedTools?: string[];
  /** Internal: override the persisted model (used by cross-provider switch recreate). */
  modelOverride?: string;
  /** Internal: this resume RECREATES a currently/recently-active session (model switch,
   *  context-budget change) rather than opening a cold one. Suppresses cold-resume
   *  auto-defer (Phase C2) so a warm working session is never silently shrunk — the
   *  "warm/model-switch never auto-mutated" invariant. Genuine user cold-opens (the route
   *  resume paths) leave it unset. */
  warmRecreate?: boolean;
}

export interface ResumeResult {
  sessionId: string;
  /** If set, the original CWD was missing and this fallback was used */
  usedFallbackCwd?: string;
  /** If set, session was auto-repaired before resuming */
  repairMessage?: string;
}

export interface SessionIdRef {
  id: string;
}

export type ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => unknown[];

export interface SessionStateConfig {
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
  sessions: SessionListItem[];
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
  data?: Record<string, unknown>;
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
