import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getCliOAuthTokens } from './cli-oauth.js';
import type { CreateConfig, ResumeConfig, ResumeResult, SystemMessage } from './types.js';
import { registerSession, unregisterSession, ensureSessionMeta, getSessionMeta, setSessionMeta, getSessionIconPath, getMcpAuth, type SessionKind } from './storage.js';
import { readSessionWorkspace, readSessionEvents, parseSessionModel, listSessionIds } from './sdk-session-store.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { CorrelationMetrics, DEFAULT_RULES, type CorrelationRules } from './correlation-metrics.js';
import { dispatchState } from './dispatch-state.js';

/**
 * Load MCP server config from ~/.copilot/mcp-config.json
 * Injects OAuth tokens from CLI's mcp-oauth-config for remote servers.
 */
function loadMcpServers(): Record<string, unknown> | undefined {
  try {
    const configPath = join(homedir(), '.copilot', 'mcp-config.json');
    if (!existsSync(configPath)) return undefined;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      injectOAuthTokens(config.mcpServers);
      console.log(`[MCP] Loaded ${Object.keys(config.mcpServers).length} servers from mcp-config.json`);
      return config.mcpServers;
    }
  } catch (e) {
    console.error('[MCP] Failed to load mcp-config.json:', e);
  }
  return undefined;
}

/**
 * Inject OAuth tokens into remote MCP server configs.
 * Checks Caco's own auth store first, then CLI tokens as fallback.
 */
function injectOAuthTokens(servers: Record<string, Record<string, unknown>>): void {
  const cacoAuth = getMcpAuth();

  for (const [name, server] of Object.entries(servers)) {
    const url = server.url as string | undefined;
    if (!url || server.type === 'local') continue;

    // Check Caco's own auth store first
    const serverId = new URL(url).hostname.replace(/\./g, '-');
    const cacoServer = cacoAuth.servers[serverId];
    if (cacoServer?.token && (!cacoServer.expiresAt || cacoServer.expiresAt > Date.now())) {
      const headers = (server.headers || {}) as Record<string, string>;
      headers['Authorization'] = `Bearer ${cacoServer.token}`;
      server.headers = headers;
      console.log(`[MCP] Injected Caco token for ${name}`);
      continue;
    }

    // Fall back to CLI tokens
    const tokens = getCliOAuthTokens(url);
    if (!tokens) continue;

    if (tokens.expiresAt && tokens.expiresAt < Date.now() / 1000) {
      console.log(`[MCP] Token expired for ${name}, skipping injection`);
      continue;
    }

    const headers = (server.headers || {}) as Record<string, string>;
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    server.headers = headers;
    console.log(`[MCP] Injected CLI token for ${name}`);
  }
}

/**
 * Repair corrupted session events.jsonl.
 * - Fixes missing ephemeral:true on session.shutdown
 * - For unknown event types: truncates to the last session.idle before the bad line
 * Returns a description of what was repaired, or null if no repair was possible.
 */
function repairSessionEvents(sessionId: string, errorMessage?: string): string | null {
  const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  try {
    let content = readFileSync(eventsPath, 'utf-8');

    // Fix missing ephemeral:true on session.shutdown
    const needle = '"type":"session.shutdown","data":{';
    if (content.includes(needle)) {
      content = content.replaceAll(needle, '"type":"session.shutdown","ephemeral":true,"data":{');
      writeFileSync(eventsPath, content);
      console.log(`[SESSION] Repaired ephemeral field in ${eventsPath}`);
      return 'Fixed missing ephemeral flag on shutdown events';
    }

    // Fix missing displayName on attachments (SDK started requiring it)
    if (errorMessage?.includes('displayName')) {
      const lines = content.split('\n');
      let fixed = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('"attachments"')) continue;
        try {
          const obj = JSON.parse(lines[i]);
          const atts = obj?.data?.attachments;
          if (!Array.isArray(atts)) continue;
          for (const att of atts) {
            if (!att.displayName) {
              att.displayName = att.path ? att.path.split('/').pop() : 'attachment';
              fixed++;
            }
          }
          if (fixed) lines[i] = JSON.stringify(obj);
        } catch { /* skip unparseable lines */ }
      }
      if (fixed) {
        writeFileSync(eventsPath, lines.join('\n'));
        console.log(`[SESSION] Repaired ${fixed} attachment(s) missing displayName in ${eventsPath}`);
        return `Fixed ${fixed} attachment(s) missing displayName`;
      }
    }

    // For unknown event types or other corruption: truncate to last session.idle
    if (errorMessage?.includes('Unknown event type') || errorMessage?.includes('corrupted')) {
      const lines = content.split('\n');

      // Find the bad line number from error message (e.g., "line 1845:")
      const lineMatch = errorMessage?.match(/line (\d+)/);
      const badLineNum = lineMatch ? parseInt(lineMatch[1], 10) : lines.length;

      // Find last session.idle before the bad line
      let truncateAt = -1;
      for (let i = Math.min(badLineNum - 1, lines.length - 1); i >= 0; i--) {
        if (lines[i].includes('"type":"session.idle"')) {
          truncateAt = i;
          break;
        }
      }

      if (truncateAt < 0) return null; // No safe truncation point

      const kept = lines.slice(0, truncateAt + 1);
      const removed = lines.length - kept.length;
      writeFileSync(eventsPath, kept.join('\n') + '\n');
      console.log(`[SESSION] Truncated ${eventsPath} to line ${truncateAt + 1}, removed ${removed} lines after last idle`);
      return `Truncated session history to last stable point (removed ${removed} lines). Recent conversation may be lost.`;
    }

    return null;
  } catch (e) {
    console.error(`[SESSION] Failed to repair ${eventsPath}:`, e);
    return null;
  }
}

interface CopilotClientInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  ping(message?: string): Promise<{ message: string; timestamp: number }>;
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
  setModel(model: string): Promise<void>;
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
}

interface CachedSession {
  cwd: string | null;
  summary: string | null;
}

interface SessionListItem {
  sessionId: string;
  cwd: string | null;
  model: string | null;
  name: string;
  kind: SessionKind;
  summary: string | null;
  updatedAt: string | Date | null;
  isBusy: boolean;
  isUnobserved: boolean;
  currentIntent: string | null;
  contextFiles: string[] | null;
  hasIcon: boolean;
  scheduleSlug: string | null;
  scheduleNextRun: string | null;
}

interface GroupedSessions {
  [cwd: string]: SessionListItem[];
}

// ============================================================================
// Model Query Helpers
// ============================================================================

/**
 * Sync model to cache. Called on create (with model) or resume (parses SDK).
 */
function syncModelCache(sessionId: string, model?: string): void {
  const resolvedModel = model ?? parseSessionModel(sessionId);
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
  
  // sessionId → { cwd, session }
  private activeSessions = new Map<string, ActiveSession>();
  
  // sessionId → { cwd, summary } (cached from disk)
  private sessionCache = new Map<string, CachedSession>();
  
  // sessionId → Promise (serializes concurrent resume attempts)
  private resumeInProgress = new Map<string, Promise<ResumeResult>>();
  
  // Shared SDK client — all sessions use one CLI backend process
  private sharedClient: CopilotClientInstance | null = null;
  private clientStarting: Promise<CopilotClientInstance> | null = null;
  
  private static readonly MAX_ACTIVE_SESSIONS = 5;
  private cachedModels: SDKModelInfo[] = [];
  private initialized = false;

  /**
   * Get or create the shared SDK client. Mutex prevents concurrent starts.
   * If the CLI process died, callers should set sharedClient = null and retry.
   */
  private async ensureClient(): Promise<CopilotClientInstance> {
    if (this.sharedClient) return this.sharedClient;
    if (this.clientStarting) return this.clientStarting;
    
    this.clientStarting = (async () => {
      const client = new CopilotClient({ cwd: process.cwd() }) as unknown as CopilotClientInstance;
      await client.start();
      this.sharedClient = client;
      console.log('[SDK] Shared client started');
      return client;
    })();
    
    try {
      return await this.clientStarting;
    } finally {
      this.clientStarting = null;
    }
  }

  /**
   * Handle SDK connection errors by resetting the shared client.
   * Callers should re-throw the original error after calling this.
   */
  private handleClientError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('connection') || msg.includes('EPIPE') || msg.includes('killed') || msg.includes('spawn')) {
      console.warn('[SDK] Shared client appears dead, will recreate on next use');
      this.sharedClient = null;
    }
  }

  async ensureClientHealthy(): Promise<void> {
    const client = await this.ensureClient();
    try {
      await Promise.race([
        client.ping('health'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000))
      ]);
    } catch (e) {
      console.warn('[SDK] Ping failed, resetting client:', e instanceof Error ? e.message : e);
      this.sharedClient = null;
      await this.ensureClient();
    }
  }

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
      const client = await this.ensureClient();
      this.cachedModels = await client.listModels();
      console.log(`✓ Fetched ${this.cachedModels.length} models from SDK`);
    } catch (e) {
      this.handleClientError(e);
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Could not fetch models from SDK: ${message}`);
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
    
    for (const sessionId of listSessionIds()) {
      const record: CachedSession = { cwd: null, summary: null };
      
      const events = readSessionEvents(sessionId);
      if (events.length === 0) continue;
      
      const startEvent = events[0];
      if (startEvent.type === 'session.start') {
        const ctx = startEvent.data?.context as Record<string, unknown> | undefined;
        record.cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : null;
      }
      
      const workspace = readSessionWorkspace(sessionId);
      if (workspace) {
        record.summary = workspace.summary ?? null;
      }
      
      this.sessionCache.set(sessionId, record);
    }
  }

  /** Re-scan disk for sessions (e.g., after import) */
  refreshCache(): void {
    this._discoverSessions();
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
    
    const client = await this.ensureClient();
    
    const sessionRef = { id: 'PENDING' };
    const tools = config.toolFactory(cwd, sessionRef);
    
    let session: CopilotSessionInstance;
    try {
      session = await client.createSession({
        model: config.model,
        streaming: true,
        systemMessage: config.systemMessage,
        tools,
        excludedTools: config.excludedTools,
        onPermissionRequest: approveAll,
        configDir: join(homedir(), '.copilot'),
        mcpServers: loadMcpServers(),
        workingDirectory: cwd
      } as CreateSessionConfig);
    } catch (e) {
      this.handleClientError(e);
      throw e;
    }
    
    sessionRef.id = session.sessionId;
    
    this.activeSessions.set(session.sessionId, { cwd, session });
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
   * 
   * Uses a per-session mutex to prevent concurrent resume attempts from
   * creating duplicate SDK clients. If a resume is already in progress
   * for the same sessionId, callers wait for that result instead.
   * 
   * @param config - Required config with toolFactory (prevents resuming without tools)
   * @returns ResumeResult with sessionId and optional fallback CWD used
   * @throws Error if session doesn't exist
   */
  async resume(sessionId: string, config: ResumeConfig): Promise<ResumeResult> {
    // If a resume is already in progress for this session, wait for it
    const existing = this.resumeInProgress.get(sessionId);
    if (existing) {
      console.log(`[RESUME] Waiting for in-progress resume of ${sessionId}`);
      return existing;
    }
    
    const promise = this._doResume(sessionId, config);
    this.resumeInProgress.set(sessionId, promise);
    
    try {
      return await promise;
    } finally {
      this.resumeInProgress.delete(sessionId);
    }
  }
  
  /**
   * Internal resume implementation (called by resume() after mutex check)
   */
  private async _doResume(sessionId: string, config: ResumeConfig): Promise<ResumeResult> {
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
    
    const client = await this.ensureClient();
    
    const sessionRef = { id: sessionId };
    const tools = config.toolFactory(cwd, sessionRef);
    
    let session: CopilotSessionInstance;
    let repairMessage: string | undefined;
    try {
      session = await client.resumeSession(sessionId, {
        streaming: true,
        tools,
        excludedTools: config.excludedTools,
        onPermissionRequest: approveAll,
        configDir: join(homedir(), '.copilot'),
        mcpServers: loadMcpServers(),
        workingDirectory: cwd
      } as ResumeSessionConfig);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Session file is corrupted')) {
        console.warn(`[SESSION] Attempting auto-repair for corrupted session ${sessionId}: ${msg}`);
        const repair = repairSessionEvents(sessionId, msg);
        if (repair) {
          repairMessage = repair;
          // Retry once after repair
          try {
            session = await client.resumeSession(sessionId, {
              streaming: true,
              tools,
              excludedTools: config.excludedTools,
              onPermissionRequest: approveAll,
              configDir: join(homedir(), '.copilot'),
              mcpServers: loadMcpServers(),
              workingDirectory: cwd
            } as ResumeSessionConfig);
          } catch (retryErr) {
            this.handleClientError(retryErr);
            throw retryErr;
          }
        } else {
          this.handleClientError(e);
          throw e;
        }
      } else {
        this.handleClientError(e);
        throw e;
      }
    }
    
    this.activeSessions.set(sessionId, { cwd, session });
    
    // Evict oldest inactive sessions if over the limit
    this._evictInactiveSessions();
    
    // Register with storage layer for output persistence
    registerSession(cwd, sessionId);
    ensureSessionMeta(sessionId);
    
    // Sync model from SDK to cache (may have changed via copilot-cli)
    syncModelCache(sessionId);
    
    console.log(`✓ Resumed session ${sessionId} for ${cwd}${usedFallbackCwd ? ' (fallback)' : ''}${repairMessage ? ' (repaired)' : ''}`);
    return { sessionId, usedFallbackCwd, repairMessage };
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
    
    const { cwd, session } = active;
    
    try {
      await session.destroy();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: session.destroy() failed: ${message}`);
    }
    
    // Note: we do NOT stop the shared client here — other sessions use it.
    // session.destroy() removes the session from the SDK but leaves a small
    // entry in client.sessions Map. This is acceptable; client.stop() on
    // shutdown clears everything.
    
    // Clear dispatch state and untrack
    dispatchState.end(sessionId);
    this.activeSessions.delete(sessionId);
    
    // Unregister from storage layer
    unregisterSession(cwd);
    
    console.log(`✓ Stopped session ${sessionId}`);
  }

  /**
   * Evict oldest inactive sessions when over MAX_ACTIVE_SESSIONS.
   * Only evicts sessions that are not currently busy (not dispatching).
   * Called after resume() adds a new active session.
   */
  private _evictInactiveSessions(): void {
    if (this.activeSessions.size <= SessionManager.MAX_ACTIVE_SESSIONS) return;
    
    // Find inactive (not busy) sessions to evict
    const candidates: string[] = [];
    for (const [id] of this.activeSessions) {
      if (!dispatchState.isBusy(id)) {
        candidates.push(id);
      }
    }
    
    // Evict oldest candidates (Map preserves insertion order, oldest first)
    // Keep at least MAX_ACTIVE_SESSIONS total
    const toEvict = this.activeSessions.size - SessionManager.MAX_ACTIVE_SESSIONS;
    for (let i = 0; i < Math.min(toEvict, candidates.length); i++) {
      const id = candidates[i];
      console.log(`[EVICT] Stopping inactive session ${id} (${this.activeSessions.size} active, max ${SessionManager.MAX_ACTIVE_SESSIONS})`);
      this.stop(id).catch(err => {
        console.warn(`[EVICT] Failed to stop session ${id}:`, err instanceof Error ? err.message : err);
      });
    }
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
    return readSessionEvents(sessionId) as SessionEvent[];
  }

  /**
   * Delete a session from disk
   */
  async delete(sessionId: string): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      await this.stop(sessionId);
    }
    
    try {
      const client = await this.ensureClient();
      await client.deleteSession(sessionId);
      console.log(`✓ Deleted session ${sessionId}`);
    } catch (e) {
      this.handleClientError(e);
      throw e;
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
      const workspace = readSessionWorkspace(sessionId);
      if (workspace?.updatedAt) updatedAt = workspace.updatedAt;
      const isBusy = this.isBusy(sessionId);
      const meta = getSessionMeta(sessionId);
      const name = meta?.name || '';
      const model = meta?.model || null;
      const isUnobserved = unobservedTracker.isUnobserved(sessionId);
      const currentIntent = meta?.currentIntent || null;
      const contextFiles = meta?.context?.files?.slice(0, 3) || null;
      const kind: SessionKind = meta?.kind ?? 'interactive';
      const scheduleSlug = null;
      const scheduleNextRun = null;
      const hasIcon = getSessionIconPath(sessionId) !== null;
      result.push({ sessionId, cwd, model, name, kind, summary, updatedAt, isBusy, isUnobserved, currentIntent, contextFiles, hasIcon, scheduleSlug, scheduleNextRun });
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
        const workspace = readSessionWorkspace(s.sessionId);
        const ts = workspace?.updatedAt ? new Date(workspace.updatedAt) : new Date(0);
        return { ...s, updatedAt: ts };
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

  getSessionModel(sessionId: string): string | null {
    return _getSessionModel(sessionId);
  }

  /**
   * Change the model for an active session.
   * Takes effect on the next message. Conversation history preserved.
   */
  async setSessionModel(sessionId: string, model: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    await active.session.setModel(model);
    syncModelCache(sessionId, model);
    console.log(`[MODEL] Changed session ${sessionId.slice(0, 8)} to ${model}`);
  }

  async compactSession(sessionId: string): Promise<{ tokensRemoved: number; messagesRemoved: number }> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    const session = active.session as unknown as { rpc: { compaction: { compact: () => Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }> } } };
    const result = await session.rpc.compaction.compact();
    if (!result.success) {
      throw new Error('Compaction failed');
    }
    console.log(`[COMPACT] Session ${sessionId.slice(0, 8)}: removed ${result.tokensRemoved} tokens, ${result.messagesRemoved} messages`);
    return { tokensRemoved: result.tokensRemoved, messagesRemoved: result.messagesRemoved };
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
    return readSessionEvents(sessionId).length > 1;
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

  /**
   * Shut down the shared SDK client. Call after all sessions are destroyed.
   */
  async shutdown(): Promise<void> {
    if (this.sharedClient) {
      try {
        await this.sharedClient.stop();
      } catch (e) {
        console.warn('[SDK] Error stopping shared client:', e instanceof Error ? e.message : e);
      }
      this.sharedClient = null;
      console.log('[SDK] Shared client stopped');
    }
  }
}

const sessionManager = new SessionManager();
export default sessionManager;
