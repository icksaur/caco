import { CopilotClient } from '@github/copilot-sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import type { CreateConfig, ResumeConfig, ResumeResult, SystemMessage } from './types.js';
import { parseSessionStartEvent, parseWorkspaceYaml } from './session-parsing.js';
import { registerSession, unregisterSession, ensureSessionMeta, getSessionMeta, setSessionMeta } from './storage.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { CorrelationMetrics, DEFAULT_RULES, type CorrelationRules } from './correlation-metrics.js';
import { dispatchState } from './dispatch-state.js';
import { buildResumeContextForSession } from './prompts.js';

interface CopilotClientInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(config: CreateSessionConfig): Promise<CopilotSessionInstance>;
  resumeSession(sessionId: string, config?: ResumeSessionConfig): Promise<CopilotSessionInstance>;
  deleteSession(sessionId: string): Promise<void>;
  listModels(): Promise<SDKModelInfo[]>;
}

interface SDKModelInfo {
  id: string;
  name: string;
  capabilities: {
    supports: { vision: boolean };
    limits: { max_context_window_tokens: number };
  };
  policy?: { state: string; terms: string };
  billing?: { multiplier: number };
}

interface CreateSessionConfig {
  model?: string;
  streaming?: boolean;
  systemMessage?: SystemMessage;
  tools?: unknown[];
  excludedTools?: string[];
}

interface ResumeSessionConfig {
  streaming?: boolean;
  tools?: unknown[];
  excludedTools?: string[];
}

interface CopilotSessionInstance {
  sessionId: string;
  send(options: SendOptions): AsyncIterable<SessionEvent>;
  sendAndWait(options: SendOptions, timeout?: number): Promise<unknown>;
  getMessages(): Promise<SessionEvent[]>;
  destroy(): Promise<void>;
}

interface SendOptions {
  prompt: string;
  attachments?: Array<{ type: string; path: string }>;
  mode?: string;
}

interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ActiveSession {
  cwd: string;
  session: CopilotSessionInstance;
  client: CopilotClientInstance;
  pendingResumeContext: boolean; // True if session was just resumed and needs context injection
}

interface CachedSession {
  cwd: string | null;
  summary: string | null;
}

interface SessionListItem {
  sessionId: string;
  cwd: string | null;
  model: string | null;   // Last known model (from cache)
  name: string;           // Custom name from ~/.caco/sessions/<id>/meta.json
  summary: string | null; // SDK-generated summary
  updatedAt: string | Date | null;
  isBusy: boolean;
  isUnobserved: boolean;  // Session completed work since last viewed
  currentIntent: string | null; // Last reported intent
  scheduleSlug: string | null;  // If created by a schedule
  scheduleNextRun: string | null; // Next scheduled run time
}

interface GroupedSessions {
  [cwd: string]: SessionListItem[];
}

// ============================================================================
// Model Query Helpers
// ============================================================================

/**
 * Parse model from SDK session events (authoritative source).
 * Falls back gracefully if file missing or format changed.
 */
function parseModelFromSDK(sessionId: string): string | null {
  try {
    const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    if (!existsSync(eventsPath)) return null;
    
    const firstLine = readFileSync(eventsPath, 'utf8').split('\n')[0];
    const event = JSON.parse(firstLine);
    if (event.type === 'session.start' && event.data?.selectedModel) {
      return event.data.selectedModel;
    }
    console.warn(`[MODEL] Unexpected event format for ${sessionId}`);
  } catch (e) {
    console.warn(`[MODEL] Could not parse SDK events for ${sessionId}: ${e instanceof Error ? e.message : e}`);
  }
  return null;
}

/**
 * Sync model to cache. Called on create (with model) or resume (parses SDK).
 */
function syncModelCache(sessionId: string, model?: string): void {
  const resolvedModel = model ?? parseModelFromSDK(sessionId);
  if (resolvedModel) {
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    if (meta.model !== resolvedModel) {
      setSessionMeta(sessionId, { ...meta, model: resolvedModel });
    }
  }
}

/**
 * Get model from cache (sync happens on create/resume).
 */
function _getSessionModel(sessionId: string): string | null {
  const meta = getSessionMeta(sessionId);
  return meta?.model ?? null;
}

// ============================================================================

/**
 * SessionManager - Singleton that owns all SDK interactions
 * 
 * Enforces one active session per cwd (working directory).
 * Discovers existing sessions from ~/.copilot/session-state/
 */
class SessionManager {
  // Correlation tracking for agent runaway guard
  private correlations = new Map<string, CorrelationMetrics>();
  private correlationRules: CorrelationRules = DEFAULT_RULES;
  
  // sessionId → { cwd, session, client }
  private activeSessions = new Map<string, ActiveSession>();
  
  // sessionId → { cwd, summary } (cached from disk)
  private sessionCache = new Map<string, CachedSession>();
  
  // Path to session state directory
  private stateDir = join(homedir(), '.copilot', 'session-state');
  
  // Cached model list from SDK
  private cachedModels: SDKModelInfo[] = [];
  
  private initialized = false;

  /**
   * Initialize: scan disk, build session cache, and fetch model list
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    this._discoverSessions();
    
    // Hydrate unobserved tracker with discovered session IDs
    unobservedTracker.hydrate(Array.from(this.sessionCache.keys()));
    
    await this._fetchModels();
    this.initialized = true;
    console.log(`✓ SessionManager initialized (${this.sessionCache.size} sessions, ${this.cachedModels.length} models)`);
  }
  
  /**
   * Fetch available models from SDK
   */
  private async _fetchModels(): Promise<void> {
    try {
      const client = new CopilotClient({ cwd: process.cwd() }) as unknown as CopilotClientInstance;
      await client.start();
      this.cachedModels = await client.listModels();
      await client.stop();
      console.log(`✓ Fetched ${this.cachedModels.length} models from SDK`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Could not fetch models from SDK: ${message}`);
      // Fall back to empty - client will use hardcoded list
      this.cachedModels = [];
    }
  }
  
  /**
   * Get cached model list
   */
  getModels(): SDKModelInfo[] {
    return this.cachedModels;
  }

  /**
   * Scan ~/.copilot/session-state/ and extract sessionId, cwd, summary
   */
  private _discoverSessions(): void {
    this.sessionCache.clear();
    
    if (!existsSync(this.stateDir)) return;
    
    for (const sessionId of readdirSync(this.stateDir)) {
      const sessionDir = join(this.stateDir, sessionId);
      const record: CachedSession = { cwd: null, summary: null };
      
      // Get cwd from events.jsonl (first line)
      try {
        const eventsPath = join(sessionDir, 'events.jsonl');
        const firstLine = readFileSync(eventsPath, 'utf8').split('\n')[0];
        record.cwd = parseSessionStartEvent(firstLine).cwd;
      } catch { /* missing or invalid */ }
      
      // Get summary from workspace.yaml
      try {
        const yamlPath = join(sessionDir, 'workspace.yaml');
        record.summary = parseWorkspaceYaml(readFileSync(yamlPath, 'utf8')).summary;
      } catch { /* missing or invalid */ }
      
      this.sessionCache.set(sessionId, record);
    }
  }

  /**
   * Create a new session for the given cwd
   * @param config - Required config with toolFactory (prevents sessions without tools)
   */
  async create(cwd: string, config: CreateConfig): Promise<string> {
    // Model is REQUIRED - fail loudly if not provided
    if (!config.model) {
      throw new Error('Model is required when creating a session');
    }
    
    console.log(`[MODEL] SessionManager.create() with model: ${config.model}`);
    
    // Create client with cwd
    const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
    await client.start();
    
    // For new sessions, create a mutable ref with placeholder
    // The ref will be updated after session creation so tools can access real ID
    const sessionRef = { id: 'PENDING' };
    const tools = config.toolFactory(cwd, sessionRef);
    
    // Create session with streaming enabled
    const session = await client.createSession({
      model: config.model,
      streaming: true,
      systemMessage: config.systemMessage,
      tools,
      excludedTools: config.excludedTools
    });
    
    // Update the ref so tool handlers can access the real session ID
    sessionRef.id = session.sessionId;
    
    // Track active session (no resume context needed for new sessions)
    this.activeSessions.set(session.sessionId, { cwd, session, client, pendingResumeContext: false });
    this.sessionCache.set(session.sessionId, { cwd, summary: null });
    
    // Register with storage layer for output persistence
    registerSession(cwd, session.sessionId);
    ensureSessionMeta(session.sessionId);
    
    // Cache model in metadata
    syncModelCache(session.sessionId, config.model);
    
    console.log(`✓ Created session ${session.sessionId} for ${cwd} with model ${config.model}`);
    return session.sessionId;
  }

  /**
   * Resume an existing session
   * @param config - Required config with toolFactory (prevents resuming without tools)
   * @returns ResumeResult with sessionId and optional fallback CWD used
   * @throws Error if session doesn't exist
   */
  async resume(sessionId: string, config: ResumeConfig): Promise<ResumeResult> {
    // Get cwd from cache
    const cached = this.sessionCache.get(sessionId);
    if (!cached) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const originalCwd = cached.cwd;
    if (!originalCwd) {
      throw new Error(`Session ${sessionId} has no cwd recorded`);
    }
    
    // Use original CWD if it exists, otherwise fall back to process.cwd()
    // CWD is mainly a context hint - sessions can resume even if original dir is gone
    let cwd = originalCwd;
    let usedFallbackCwd: string | undefined;
    if (!existsSync(originalCwd)) {
      cwd = process.cwd();
      usedFallbackCwd = cwd;
      console.log(`[RESUME] Original CWD gone (${originalCwd}), using fallback: ${cwd}`);
    }
    
    // Already active?
    if (this.activeSessions.has(sessionId)) {
      console.log(`Session ${sessionId} already active`);
      return { sessionId, usedFallbackCwd };
    }
    
    // Create client with cwd
    const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
    await client.start();
    
    // Create tools using factory (cwd and sessionRef for agent tools)
    // For resume, we know the sessionId upfront
    const sessionRef = { id: sessionId };
    const tools = config.toolFactory(cwd, sessionRef);
    
    // Resume session with tools
    const session = await client.resumeSession(sessionId, {
      streaming: true,
      tools,
      excludedTools: config.excludedTools
    });
    
    // Track active session (needs resume context on first message)
    this.activeSessions.set(sessionId, { cwd, session, client, pendingResumeContext: true });
    
    // Register with storage layer for output persistence
    registerSession(cwd, sessionId);
    ensureSessionMeta(sessionId);
    
    // Sync model from SDK to cache (may have changed via copilot-cli)
    syncModelCache(sessionId);
    
    console.log(`✓ Resumed session ${sessionId} for ${cwd}${usedFallbackCwd ? ' (fallback)' : ''}`);
    return { sessionId, usedFallbackCwd };
  }

  /**
   * Stop an active session (releases lock)
   */
  async stop(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      console.log(`Session ${sessionId} not active, nothing to stop`);
      return;
    }
    
    const { cwd, session, client } = active;
    
    try {
      await session.destroy();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: session.destroy() failed: ${message}`);
    }
    
    try {
      await client.stop();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: client.stop() failed: ${message}`);
    }
    
    // Clear dispatch state and untrack
    dispatchState.end(sessionId);
    this.activeSessions.delete(sessionId);
    
    // Unregister from storage layer
    unregisterSession(cwd);
    
    console.log(`✓ Stopped session ${sessionId}`);
  }

  /**
   * Send a message to an active session
   * @throws Error if session is not active
   */
  async send(sessionId: string, message: string, options: Partial<SendOptions> = {}): Promise<unknown> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    
    // Inject resume context on first message after resume
    if (active.pendingResumeContext) {
      message = this.buildResumeContext(sessionId, active.cwd) + message;
      active.pendingResumeContext = false;
    }
    
    const { session } = active;
    const TIMEOUT_MS = 120000; // 2 minutes
    
    try {
      const response = await session.sendAndWait({
        ...options,
        prompt: message,  // Must come AFTER spread to override any options.prompt
      }, TIMEOUT_MS);
      
      return response;
    } catch (error) {
      // Convert SDK timeout message to user-friendly format
      if (error instanceof Error && error.message?.includes('Timeout after')) {
        throw new Error('Request timed out after 2 minutes');
      }
      throw error;
    }
  }

  /**
   * Build context message to prepend on first send after resume.
   * Delegates to prompts module.
   */
  private buildResumeContext(sessionId: string, cwd: string): string {
    return buildResumeContextForSession(sessionId, cwd);
  }

  /**
   * Get message history for a session
   * If active, uses the SDK session. Otherwise reads from disk.
   */
  async getHistory(sessionId: string): Promise<SessionEvent[]> {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      const { session } = active;
      return await session.getMessages();
    }
    
    // Not active - read from disk
    return this.getHistoryFromDisk(sessionId);
  }
  
  /**
   * Read message history from disk without activating session
   * Used for displaying history on page load before first message
   */
  private getHistoryFromDisk(sessionId: string): SessionEvent[] {
    const sessionDir = join(this.stateDir, sessionId);
    const eventsPath = join(sessionDir, 'events.jsonl');
    
    if (!existsSync(eventsPath)) {
      return [];
    }
    
    try {
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const events: SessionEvent[] = [];
      
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          events.push(event);
        } catch {
          // Skip malformed lines
        }
      }
      
      return events;
    } catch (e) {
      console.error(`Error reading events from disk for ${sessionId}:`, e);
      return [];
    }
  }

  /**
   * Delete a session from disk
   */
  async delete(sessionId: string): Promise<void> {
    // Stop if active
    if (this.activeSessions.has(sessionId)) {
      await this.stop(sessionId);
    }
    
    // Get CWD for client - use process.cwd() if cached CWD is gone
    const cached = this.sessionCache.get(sessionId);
    const cachedCwd = cached?.cwd;
    const cwd = (cachedCwd && existsSync(cachedCwd)) ? cachedCwd : process.cwd();
    
    const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
    await client.start();
    
    try {
      await client.deleteSession(sessionId);
      console.log(`✓ Deleted session ${sessionId}`);
    } finally {
      await client.stop();
    }
    
    this.sessionCache.delete(sessionId);
  }

  /**
   * List all sessions (from cache) with updatedAt
   */
  list(): SessionListItem[] {
    const result: SessionListItem[] = [];
    for (const [sessionId, { cwd, summary }] of this.sessionCache) {
      let updatedAt: string | null = null;
      try {
        const yamlPath = join(this.stateDir, sessionId, 'workspace.yaml');
        const yaml = parseYaml(readFileSync(yamlPath, 'utf8')) as { updated_at?: string };
        updatedAt = yaml.updated_at || null;
      } catch { /* missing */ }
      const isBusy = this.isBusy(sessionId);
      const meta = getSessionMeta(sessionId);
      const name = meta?.name || '';
      const model = meta?.model || null;
      const isUnobserved = unobservedTracker.isUnobserved(sessionId);
      const currentIntent = meta?.currentIntent || null;
      // Schedule info is filled in by the route handler (async lookup)
      const scheduleSlug = null;
      const scheduleNextRun = null;
      result.push({ sessionId, cwd, model, name, summary, updatedAt, isBusy, isUnobserved, currentIntent, scheduleSlug, scheduleNextRun });
    }
    return result;
  }

  /**
   * List all sessions grouped by cwd
   */
  listAllGrouped(): GroupedSessions {
    const sessions = this.list();
    const grouped: GroupedSessions = {};
    
    for (const s of sessions) {
      const key = s.cwd || '(unknown)';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    }
    
    // Sort each group by updatedAt descending
    for (const cwd of Object.keys(grouped)) {
      grouped[cwd].sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      });
    }
    
    return grouped;
  }

  /**
   * List sessions for a specific cwd
   */
  listByCwd(cwd: string): SessionListItem[] {
    return this.list().filter(s => s.cwd === cwd);
  }

  /**
   * Get the most recent session for a cwd
   */
  getMostRecentForCwd(cwd: string): string | null {
    const sessions = this.listByCwd(cwd);
    if (sessions.length === 0) return null;
    
    // Sort by modified time (newest first)
    const sorted = sessions
      .map(s => {
        const yamlPath = join(this.stateDir, s.sessionId, 'workspace.yaml');
        try {
          const yaml = parseYaml(readFileSync(yamlPath, 'utf8')) as { updated_at?: string };
          return { ...s, updatedAt: new Date(yaml.updated_at || 0) };
        } catch {
          return { ...s, updatedAt: new Date(0) };
        }
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    
    return sorted[0]?.sessionId || null;
  }

  /**
   * Get cwd for a session
   */
  getSessionCwd(sessionId: string): string | null {
    return this.sessionCache.get(sessionId)?.cwd || null;
  }

  /**
   * Check if a session is active
   */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Check if a session is currently processing a message
   */
  isBusy(sessionId: string): boolean {
    return dispatchState.isBusy(sessionId);
  }

  /**
   * Start a dispatch - marks session busy with correlation context
   * Called before dispatching to SDK. Tools can inherit correlationId.
   */
  startDispatch(sessionId: string, correlationId: string): void {
    dispatchState.start(sessionId, correlationId);
  }

  /**
   * End a dispatch - clears busy state and correlation context
   * Called when dispatch completes (idle, error, or timeout).
   */
  endDispatch(sessionId: string): void {
    dispatchState.end(sessionId);
  }

  /**
   * Get correlationId for active dispatch (used by tools)
   * Returns undefined if no dispatch is active.
   */
  getDispatchCorrelationId(sessionId: string): string | undefined {
    return dispatchState.getCorrelationId(sessionId);
  }

  /**
   * Check if a session has messages (i.e., can be resumed)
   */
  hasMessages(sessionId: string): boolean {
    const sessionDir = join(this.stateDir, sessionId);
    const eventsPath = join(sessionDir, 'events.jsonl');
    try {
      const content = readFileSync(eventsPath, 'utf8');
      // Count actual message events (not just session.start)
      const lines = content.split('\n').filter(l => l.trim());
      return lines.length > 1; // More than just session.start
    } catch {
      return false;
    }
  }

  /**
   * Get the raw session object for event subscription
   */
  getSession(sessionId: string): CopilotSessionInstance | null {
    const active = this.activeSessions.get(sessionId);
    if (!active) return null;
    return active.session;
  }

  /**
   * Send a message without waiting (for streaming)
   * @throws Error if session is not active
   */
  sendStream(sessionId: string, message: string, options: Partial<SendOptions> = {}): AsyncIterable<SessionEvent> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    
    // Inject resume context on first message after resume
    if (active.pendingResumeContext) {
      console.log(`[RESUME-CTX] Injecting resume context for session ${sessionId.slice(0, 8)}`);
      message = this.buildResumeContext(sessionId, active.cwd) + message;
      active.pendingResumeContext = false;
      console.log(`[RESUME-CTX] Full message starts with: ${message.slice(0, 100)}...`);
    }
    
    const { session } = active;
    return session.send({
      ...options,
      prompt: message,  // Must come AFTER spread to override any options.prompt
    });
  }

  /**
   * Check if an agent call is allowed (runaway guard)
   * 
   * @param correlationId - Correlation ID for the flow
   * @param toSessionId - Session being called
   * @returns { allowed: true } or { allowed: false, reason: string }
   */
  checkAgentCall(correlationId: string, toSessionId: string): { allowed: true } | { allowed: false; reason: string } {
    // Get or create metrics for this correlation
    let metrics = this.correlations.get(correlationId);
    if (!metrics) {
      metrics = new CorrelationMetrics(correlationId, this.correlationRules);
      this.correlations.set(correlationId, metrics);
    }
    
    // Check if expired - clean up if so
    if (metrics.isExpired()) {
      this.correlations.delete(correlationId);
      metrics = new CorrelationMetrics(correlationId, this.correlationRules);
      this.correlations.set(correlationId, metrics);
    }
    
    return metrics.isAllowed(toSessionId);
  }

  /**
   * Record a successful agent call
   * 
   * @param correlationId - Correlation ID for the flow
   * @param toSessionId - Session that was called
   */
  recordAgentCall(correlationId: string, toSessionId: string): void {
    let metrics = this.correlations.get(correlationId);
    if (!metrics) {
      metrics = new CorrelationMetrics(correlationId, this.correlationRules);
      this.correlations.set(correlationId, metrics);
    }
    metrics.recordCall(toSessionId);
  }

  /**
   * Get correlation metrics (for debugging)
   */
  getCorrelationMetrics(correlationId: string) {
    return this.correlations.get(correlationId)?.getMetrics();
  }
}

const sessionManager = new SessionManager();
export default sessionManager;
