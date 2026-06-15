import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { ProviderConfig } from '@github/copilot-sdk';
import { existsSync, mkdirSync, cpSync, rmSync, mkdtempSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { CreateConfig, ResumeConfig, ResumeResult, SystemMessage, SessionEvent, ToolFactory } from './types.js';
import { registerSession, unregisterSession, ensureSessionMeta, getSessionMeta, setSessionMeta, getSessionIconPath, setSessionOrder, type SessionKind } from './storage.js';
import { readSessionWorkspace, readSessionEvents, parseSessionModel, listSessionIds } from './sdk-session-store.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { CorrelationMetrics, DEFAULT_RULES, type CorrelationRules } from './correlation-metrics.js';
import { dispatchState } from './dispatch-state.js';
import { pollQuota } from './quota-poller.js';
import type { QuotaSnapshot } from './usage-state.js';
import { loadMcpServers } from './mcp-config-loader.js';
import { shouldAutoRepairSessionError, repairSessionEvents } from './session-auto-repair.js';
import { clearSession as clearThroughputSession } from './session-throughput.js';
import { hasProviders, listByokModels, resolveModel } from './provider-registry.js';
import { thresholdForBudget, type ModelTokenLimits } from './context-budget.js';

import { formatMemoryForPrompt } from './memory-tool.js';


interface McpServerInfo {
  name: string;
  status: string;
  source?: string;
  error?: string;
}

interface ToolInfo {
  name: string;
  namespacedName?: string;
  description: string;
}

interface CopilotClientInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
  ping(message?: string): Promise<{ message: string; timestamp: string }>;
  createSession(config: CreateSessionConfig): Promise<CopilotSessionInstance>;
  resumeSession(sessionId: string, config?: ResumeSessionConfig): Promise<CopilotSessionInstance>;
  deleteSession(sessionId: string): Promise<void>;
  listModels(): Promise<SDKModelInfo[]>;
  rpc: {
    account: {
      getQuota: (params: { gitHubToken?: string }) => Promise<{
        quotaSnapshots: Record<string, QuotaSnapshot | undefined>;
      }>;
    };
    models: {
      list(params: { gitHubToken?: string }): Promise<{ models: SDKModelInfo[] }>;
    };
    tools: {
      list(params: { model?: string }): Promise<{ tools: ToolInfo[] }>;
    };
    sessions: {
      fork(params: { sessionId: string; toEventId?: string }): Promise<{ sessionId: string }>;
    };
  };
}

export interface SDKModelInfo {
  id: string;
  name: string;
  capabilities?: {
    supports?: { vision?: boolean; reasoningEffort?: boolean };
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number };
  };
  policy?: { state: string; terms?: string };
  billing?: {
    multiplier?: number;
    tokenPrices?: {
      inputPrice?: number;
      outputPrice?: number;
      cachePrice?: number;
      batchSize?: number;
      contextMax?: number;
      longContext?: { inputPrice?: number; outputPrice?: number; cachePrice?: number; contextMax?: number };
    };
  };
  modelPickerCategory?: 'lightweight' | 'versatile' | 'powerful';
  modelPickerPriceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface InfiniteSessionConfig {
  enabled?: boolean;
  backgroundCompactionThreshold?: number;
  bufferExhaustionThreshold?: number;
}

interface CreateSessionConfig {
  model?: string;
  streaming?: boolean;
  systemMessage?: SystemMessage;
  tools?: unknown[];
  excludedTools?: string[];
  provider?: ProviderConfig;
  infiniteSessions?: InfiniteSessionConfig;
}

interface ResumeSessionConfig {
  streaming?: boolean;
  tools?: unknown[];
  excludedTools?: string[];
  systemMessage?: { mode: 'append'; content: string };
  model?: string;
  reasoningEffort?: string;
  provider?: ProviderConfig;
  infiniteSessions?: InfiniteSessionConfig;
}

interface CopilotSessionInstance {
  sessionId: string;
  send(options: SendOptions): Promise<string>;
  sendAndWait(options: SendOptions, timeout?: number): Promise<unknown>;
  getEvents(): Promise<SessionEvent[]>;
  disconnect(): Promise<void>;
  setModel(model: string): Promise<void>;
  abort(): Promise<void>;
  rpc: {
    history: {
      compact(params?: unknown): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }>;
    };
    mcp: {
      list(): Promise<{ servers: McpServerInfo[] }>;
    };
    model: {
      setReasoningEffort(params: { reasoningEffort: string }): Promise<{ reasoningEffort: string }>;
    };
  };
}

interface SendOptions {
  prompt: string;
  attachments?: Array<{ type: string; path: string }>;
  mode?: string;
}

interface ActiveSession {
  cwd: string;
  session: CopilotSessionInstance;
  providerId?: string;
  toolFactory: ToolFactory;
  excludedTools?: string[];
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
  folder?: string;
}

/**
 * Replicate the capability defaulting the SDK applies on its native models.list
 * path but skips when an onListModels handler is set (client.js). Ensures every
 * model has capabilities.limits.max_context_window_tokens so downstream reads
 * don't throw.
 */
function normalizeModelCapabilities(model: SDKModelInfo): SDKModelInfo {
  const caps = model.capabilities ?? {};
  return {
    ...model,
    capabilities: {
      supports: caps.supports ?? {},
      limits: {
        ...caps.limits,
        max_context_window_tokens: caps.limits?.max_context_window_tokens ?? 0,
      },
    },
  };
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
function readModelFromEvents(sessionId: string): string | null {
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
  private idleTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private static readonly SDK_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  
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
      const clientOptions: Record<string, unknown> = { workingDirectory: process.cwd() };
      // Only attach onListModels when BYOK providers are configured. With no
      // config the handler is never installed, so the SDK uses its native
      // models.list path unchanged — a no-config user sees zero behavior change.
      if (hasProviders()) {
        clientOptions.onListModels = () => this.aggregateModels();
      }
      const client = new CopilotClient(clientOptions) as unknown as CopilotClientInstance;
      await client.start();
      this.sharedClient = client;
      this.startHealthCheck();
      console.log('[SDK] Shared client started');
      void pollQuota(client);
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
      console.warn('[SDK] Shared client appears dead, force-stopping');
      const client = this.sharedClient;
      this.sharedClient = null;
      this.stopHealthCheck();
      if (client) client.forceStop().catch(() => {});
    }
  }

  async ensureClientHealthy(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const client = await this.ensureClient();
    try {
      await Promise.race([
        client.ping('health'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000))
      ]);
    } catch (e) {
      console.warn('[SDK] Ping failed, force-stopping client:', e instanceof Error ? e.message : e);
      this.stopHealthCheck();
      try { await client.forceStop(); } catch { /* already dead */ }
      this.sharedClient = null;
      this.activeSessions.clear();
      await this.ensureClient();
    }
  }

  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.sharedClient) return;
      if (dispatchState.getAllActive().size > 0) {
        console.log('[SDK] Idle timeout skipped — active dispatches exist');
        this.resetIdleTimer();
        return;
      }
      console.log('[SDK] Idle timeout, tearing down client to prevent stale connection');
      this.stopHealthCheck();
      this.sharedClient.stop().catch(() => {});
      this.sharedClient = null;
      this.activeSessions.clear();
    }, SessionManager.SDK_IDLE_TIMEOUT_MS);
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(() => {
      void this.proactiveHealthCheck();
    }, SessionManager.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  private async proactiveHealthCheck(): Promise<void> {
    if (!this.sharedClient) { this.stopHealthCheck(); return; }
    
    const client = this.sharedClient;
    const state = (client as unknown as { getState?: () => string }).getState?.();
    if (state && state !== 'connected') {
      console.warn(`[SDK] Health check: client state is "${state}", force-stopping`);
      this.sharedClient = null;
      this.activeSessions.clear();
      this.stopHealthCheck();
      try { await client.forceStop(); } catch { /* */ }
      return;
    }

    try {
      await Promise.race([
        client.ping('health-check'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000))
      ]);
      // Piggyback a quota refresh on the health check cadence so usage stays
      // current even for long-idle sessions with no turns triggering pollQuota.
      void pollQuota(client);
    } catch (e) {
      console.warn('[SDK] Health check failed, force-stopping client:', e instanceof Error ? e.message : e);
      this.sharedClient = null;
      this.activeSessions.clear();
      this.stopHealthCheck();
      try { await client.forceStop(); } catch { /* */ }
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
   * Resolve a model's prompt-token limits for context-budget math. Looks up the
   * Caco model id in the aggregated model list (GitHub + BYOK both appear there
   * with capabilities.limits populated). Returns undefined if not found.
   */
  modelTokenLimits(cacoModelId: string): ModelTokenLimits | undefined {
    const m = this.cachedModels.find(x => x.id === cacoModelId);
    if (!m) return undefined;
    return {
      maxPromptTokens: m.capabilities?.limits?.max_prompt_tokens,
      maxContextWindowTokens: m.capabilities?.limits?.max_context_window_tokens,
    };
  }

  /**
   * Build the infiniteSessions config for a session from its persisted context
   * budget, or undefined when no budget applies (so the SDK default stands).
   * Used at both create and resume.
   */
  private infiniteSessionsFor(sessionId: string, cacoModelId: string | undefined): InfiniteSessionConfig | undefined {
    if (!cacoModelId) return undefined;
    const budget = getSessionMeta(sessionId)?.contextBudgetTokens;
    if (!budget) return undefined;
    const threshold = thresholdForBudget(budget, this.modelTokenLimits(cacoModelId));
    if (threshold === null) return undefined;
    return { backgroundCompactionThreshold: threshold };
  }

  /**
   * onListModels handler — installed only when BYOK providers exist. Fetches
   * GitHub models via the raw RPC (NOT listModels(), which would recurse),
   * replicates the capability normalization the SDK skips on this path, then
   * appends BYOK models. A registry fault degrades to GitHub-only.
   */
  private async aggregateModels(): Promise<SDKModelInfo[]> {
    let githubModels: SDKModelInfo[] = [];
    try {
      const client = this.sharedClient;
      if (client) {
        const result = await client.rpc.models.list({});
        githubModels = (result.models ?? []).map(normalizeModelCapabilities);
      }
    } catch (e) {
      console.warn('[BYOK] Failed to fetch GitHub models; returning BYOK-only:', e);
    }
    let byokModels: SDKModelInfo[] = [];
    try {
      byokModels = listByokModels();
    } catch (e) {
      console.error('[BYOK] Failed to list BYOK models; returning GitHub-only:', e);
    }
    return [...githubModels, ...byokModels];
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

      // Caco-side cwd override (from /session-cwd) wins over the immutable
      // session.start cwd so a changed cwd survives server restart.
      const metaCwd = getSessionMeta(sessionId)?.cwd;
      if (metaCwd) record.cwd = metaCwd;
      
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
    
    const resolved = resolveModel(config.model);
    
    const sessionRef = { id: 'PENDING' };
    const tools = config.toolFactory(cwd, sessionRef);
    
    let session: CopilotSessionInstance;
    try {
      session = await client.createSession({
        model: resolved.sdkModel,
        streaming: true,
        systemMessage: config.systemMessage,
        tools,
        excludedTools: config.excludedTools,
        onPermissionRequest: approveAll,
        configDir: join(homedir(), '.copilot'),
        mcpServers: await loadMcpServers(),
        workingDirectory: cwd,
        ...(resolved.provider && { provider: resolved.provider }),
        // No infiniteSessions here: a brand-new session has no persisted budget
        // yet. Budgets are applied on resume (incl. the recreate triggered by
        // setSessionContextBudget). See infiniteSessionsFor / _doResume.
      } as CreateSessionConfig);
    } catch (e) {
      this.handleClientError(e);
      throw e;
    }
    
    sessionRef.id = session.sessionId;
    
    this.activeSessions.set(session.sessionId, {
      cwd,
      session,
      providerId: resolved.providerId,
      toolFactory: config.toolFactory,
      excludedTools: config.excludedTools,
    });
    this.sessionCache.set(session.sessionId, { cwd, summary: null });
    
    // Register with storage layer for output persistence
    registerSession(cwd, session.sessionId);
    ensureSessionMeta(session.sessionId);
    
    // Cache model in metadata — store the namespaced Caco id, not the SDK model
    syncModelCache(session.sessionId, resolved.cacoId);
    
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
   * Attempt in-place repair of a session history file.
   * Returns a human-readable repair description, or null if no repair was applied.
   */
  tryRepairSessionHistory(sessionId: string, errorMessage: string): string | null {
    if (!shouldAutoRepairSessionError(errorMessage)) return null;
    return repairSessionEvents(sessionId, errorMessage);
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
    
    // Re-derive the provider binding from the persisted Caco model id. For BYOK
    // sessions the namespaced id (e.g. "openrouter:...") encodes the provider;
    // the SDK only knows the agent model, so meta is the source of truth. A
    // modelOverride (cross-provider switch) forces the session onto a new model.
    const isOverride = config.modelOverride !== undefined;
    const cacoModel = config.modelOverride ?? readModelFromEvents(sessionId);
    const resolved = cacoModel ? resolveModel(cacoModel) : null;
    const applyModel = !!resolved && (!!resolved.provider || isOverride);
    const infinite = this.infiniteSessionsFor(sessionId, cacoModel ?? undefined);
    const storedEffort = getSessionMeta(sessionId)?.reasoningEffort;
    const defaultEffort = cacoModel ? this.cachedModels.find(m => m.id === cacoModel)?.defaultReasoningEffort : undefined;
    const applyEffort = storedEffort && storedEffort !== defaultEffort;
    
    let repairMessage: string | undefined;
    const memoryContent = formatMemoryForPrompt();
    const resumeArgs = {
      streaming: true,
      tools,
      excludedTools: config.excludedTools,
      onPermissionRequest: approveAll,
      configDir: join(homedir(), '.copilot'),
      mcpServers: await loadMcpServers(),
      workingDirectory: cwd,
      ...(memoryContent && { systemMessage: { mode: 'append' as const, content: memoryContent } }),
      ...(applyModel && { model: resolved.sdkModel }),
      ...(resolved?.provider && { provider: resolved.provider }),
      ...(infinite && { infiniteSessions: infinite }),
      ...(applyEffort && { reasoningEffort: storedEffort }),
    } as ResumeSessionConfig;

    const MAX_REPAIR_ATTEMPTS = 3;
    let lastFailureSignature: string | null = null;
    let attemptedSession: CopilotSessionInstance | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      try {
        attemptedSession = await client.resumeSession(sessionId, resumeArgs);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);

        // Only auto-repair known recoverable session-history corruption errors.
        if (!shouldAutoRepairSessionError(msg)) {
          this.handleClientError(e);
          throw e;
        }

        // Stop if we've hit the cap.
        if (attempt === MAX_REPAIR_ATTEMPTS) {
          console.error(`[SESSION] Auto-repair exhausted (${MAX_REPAIR_ATTEMPTS} attempts) for ${sessionId}: ${msg}`);
          this.handleClientError(e);
          throw e;
        }

        // Build a signature for the failing line so we can detect "same line
        // still failing after a no-op repair" — if repair didn't write
        // anything, retrying won't help.
        const sigMatch = msg.match(/line (\d+)/);
        const sig = sigMatch ? `line:${sigMatch[1]}` : msg.slice(0, 80);

        // Quietly attempt to repair; only the final success/failure surfaces.
        console.warn(`[SESSION] Auto-repair attempt ${attempt + 1} for ${sessionId}: ${msg}`);
        const repair = repairSessionEvents(sessionId, msg);
        if (!repair) {
          // Repair didn't know what to do. If the previous attempt also failed
          // on this same line without repair, give up (we'd just loop).
          if (sig === lastFailureSignature) {
            console.error(`[SESSION] Auto-repair stuck on ${sig}; no fix available`);
          }
          this.handleClientError(e);
          throw e;
        }

        // Repair did something. Note the signature so if the next attempt
        // fails on the same line AND repair returns null then, we know we
        // didn't actually fix line N — give up at that point.
        lastFailureSignature = sig;
        repairMessage = repair;
      }
    }

    if (!attemptedSession) {
      // Should be unreachable — every code path above either assigns or throws.
      const err = lastError instanceof Error ? lastError : new Error(String(lastError ?? 'resume failed'));
      this.handleClientError(err);
      throw err;
    }
    const session: CopilotSessionInstance = attemptedSession;
    
    this.activeSessions.set(sessionId, {
      cwd,
      session,
      providerId: resolved?.providerId,
      toolFactory: config.toolFactory,
      excludedTools: config.excludedTools,
    });
    
    // Evict oldest inactive sessions if over the limit
    this.evictInactiveSessions();
    
    // Register with storage layer for output persistence
    registerSession(cwd, sessionId);
    ensureSessionMeta(sessionId);
    
    // Sync model to cache. For BYOK or an explicit override the SDK only knows
    // the agent model, so persist the namespaced Caco id; otherwise parse from
    // SDK (the model may have changed via the external copilot-cli).
    if (applyModel && resolved.cacoId) {
      syncModelCache(sessionId, resolved.cacoId);
    } else {
      syncModelCache(sessionId);
    }
    
    console.log(`✓ Resumed session ${sessionId} for ${cwd}${usedFallbackCwd ? ' (fallback)' : ''}${repairMessage ? ' (repaired)' : ''}`);
    return { sessionId, usedFallbackCwd, repairMessage };
  }

  /**
   * Drop a session from the active map without calling session.disconnect().
   * Used when the SDK already lost track of the session (e.g., "Session not found"
   * RPC error). Allows resume() to re-register with the SDK on next attempt.
   */
  dropStaleSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    this.activeSessions.delete(sessionId);
    console.log(`[SDK] Dropped stale session ${sessionId} from active map`);
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
      await session.disconnect();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: session.disconnect() failed: ${message}`);
    }
    
    // Note: we do NOT stop the shared client here — other sessions use it.
    // session.disconnect() removes the session from the SDK but leaves a small
    // entry in client.sessions Map. This is acceptable; client.stop() on
    // shutdown clears everything.
    
    // Clear dispatch state and untrack
    dispatchState.end(sessionId);
    this.activeSessions.delete(sessionId);
    
    // Unregister from storage layer
    unregisterSession(cwd);
    clearThroughputSession(sessionId);
    
    console.log(`✓ Stopped session ${sessionId}`);
  }

  async changeCwd(sessionId: string, newCwd: string): Promise<void> {
    if (this.isBusy(sessionId)) {
      throw new Error('Cannot change CWD while session is processing');
    }

    const cached = this.sessionCache.get(sessionId);
    if (!cached) throw new Error(`Session ${sessionId} not found`);

    const oldCwd = cached.cwd;

    if (this.activeSessions.has(sessionId)) {
      await this.stop(sessionId);
    }

    cached.cwd = newCwd;
    this.sessionCache.set(sessionId, cached);
    registerSession(newCwd, sessionId);

    // Persist the override to Caco meta so it survives restart. The SDK's
    // session.start event keeps the original cwd; _discoverSessions prefers
    // this override when rebuilding the cache.
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    setSessionMeta(sessionId, { ...meta, cwd: newCwd });

    console.log(`✓ Changed CWD for ${sessionId}: ${oldCwd} → ${newCwd}`);
  }

  /**
   * Evict oldest inactive sessions when over MAX_ACTIVE_SESSIONS.
   * Only evicts sessions that are not currently busy (not dispatching).
   * Called after resume() adds a new active session.
   */
  private evictInactiveSessions(): void {
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
      return await session.getEvents();
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
    clearThroughputSession(sessionId);
  }

  async exportToFile(sessionId: string, outputPath: string): Promise<void> {
    const sdkBase = join(homedir(), '.copilot', 'session-state');
    const cacoBase = join(homedir(), '.caco', 'sessions');

    const staging = mkdtempSync(join(tmpdir(), 'caco-export-'));
    try {
      cpSync(join(sdkBase, sessionId), join(staging, 'sdk', sessionId), { recursive: true });
      if (existsSync(join(cacoBase, sessionId))) {
        cpSync(join(cacoBase, sessionId), join(staging, 'caco', sessionId), { recursive: true });
      }

      const tar = await import('tar');
      await new Promise<void>((resolve, reject) => {
        const stream = tar.create({ gzip: true, cwd: staging }, ['.']);
        const out = createWriteStream(outputPath);
        stream.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        stream.pipe(out);
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async archive(sessionId: string): Promise<{ archivePath: string }> {
    const sdkPath = join(homedir(), '.copilot', 'session-state', sessionId);
    if (!existsSync(sdkPath)) {
      throw new Error('SDK session data not found — cannot archive without full data');
    }

    if (this.activeSessions.has(sessionId)) {
      await this.stop(sessionId);
    }

    dispatchState.start(sessionId, 'archive');
    try {
      const archiveDir = join(homedir(), '.caco', 'sessions', 'archive');
      mkdirSync(archiveDir, { recursive: true });
      const archivePath = join(archiveDir, `${sessionId}.caco-session.tar.gz`);
      await this.exportToFile(sessionId, archivePath);

      const client = await this.ensureClient();
      await client.deleteSession(sessionId);

      const cacoPath = join(homedir(), '.caco', 'sessions', sessionId);
      if (existsSync(cacoPath)) {
        rmSync(cacoPath, { recursive: true });
      }

      this.sessionCache.delete(sessionId);
      console.log(`✓ Archived session ${sessionId} → ${archivePath}`);
      return { archivePath };
    } finally {
      dispatchState.end(sessionId);
    }
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
      result.push({ sessionId, cwd, model, name, kind, summary, updatedAt, isBusy, isUnobserved, currentIntent, contextFiles, hasIcon, scheduleSlug, scheduleNextRun, folder: meta?.folder });
    }
    return result;
  }

  snapshotSessionOrder(): void {
    const sessions = this.list();
    const sorted = sessions.sort((a, b) => {
      const aMeta = getSessionMeta(a.sessionId);
      const bMeta = getSessionMeta(b.sessionId);
      const aTime = aMeta?.lastUsedAt ? new Date(aMeta.lastUsedAt).getTime()
        : a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = bMeta?.lastUsedAt ? new Date(bMeta.lastUsedAt).getTime()
        : b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });
    setSessionOrder(sorted.map(s => s.sessionId));
    console.log(`[MRU] Snapshot: ${sorted.length} sessions ordered`);
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
    return readModelFromEvents(sessionId);
  }

  /**
   * Change the model for an active session.
   *
   * Fast path (GitHub → GitHub): SDK setModel preserves history in-place.
   * Recreate path (any BYOK side): the SDK binds a provider's wireModel at
   * create/resume and setModel cannot change it, so switching to/from/between
   * BYOK providers tears down the SDK session and resumes it under the new
   * model+provider. History on disk is preserved and replayed.
   *
   * resolveModel() runs before any teardown, so missing-credential switches
   * fail fast with the SDK session untouched. If the recreate resume fails for
   * another reason (e.g. history error), we roll back to the original model so
   * the session stays usable rather than orphaned.
   */
  async setSessionModel(sessionId: string, model: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }

    const resolved = resolveModel(model);
    const fastPath = !resolved.provider && !active.providerId;
    this.clearStaleReasoningEffort(sessionId, model);

    if (fastPath) {
      await active.session.setModel(resolved.sdkModel);
      syncModelCache(sessionId, resolved.cacoId);
      console.log(`[MODEL] Changed session ${sessionId.slice(0, 8)} to ${model}`);
      return;
    }

    // Cross-provider (or BYOK-involving) switch: recreate under the new binding.
    // Capture the original model first so we can roll back on resume failure.
    const previousModel = readModelFromEvents(sessionId);
    const { toolFactory, excludedTools } = active;
    try {
      await active.session.disconnect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[MODEL] disconnect during provider switch failed: ${msg}`);
    }
    dispatchState.end(sessionId);
    this.activeSessions.delete(sessionId);

    try {
      await this.resume(sessionId, { toolFactory, excludedTools, modelOverride: model });
      console.log(`[MODEL] Recreated session ${sessionId.slice(0, 8)} on ${model} (provider switch from ${active.providerId ?? 'github'})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (previousModel && previousModel !== model) {
        try {
          await this.resume(sessionId, { toolFactory, excludedTools, modelOverride: previousModel });
          console.warn(`[MODEL] Switch to ${model} failed; reverted ${sessionId.slice(0, 8)} to ${previousModel}`);
          throw new Error(`Model switch to ${model} failed (${msg}); reverted to ${previousModel}`);
        } catch (rollbackErr) {
          const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          throw new Error(`Model switch to ${model} failed (${msg}) and rollback to ${previousModel} failed (${rmsg}); session ended`);
        }
      }
      throw e;
    }
  }

  /**
   * Set (or clear, with null) the per-session context-window budget and apply
   * it immediately by recreating the SDK session (the SDK has no live setter for
   * the compaction threshold). History on disk is preserved and replayed once.
   *
   * Persists the budget to meta BEFORE recreate so _doResume's infiniteSessionsFor
   * reads the new value. On resume failure, the previous meta value is restored
   * so a failed apply doesn't leave a stale budget.
   *
   * Caller (route) must reject busy sessions; this method also refuses if the
   * session isn't active.
   */
  async setSessionContextBudget(sessionId: string, tokens: number | null): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }

    const meta = getSessionMeta(sessionId) ?? { name: '' };
    const previousBudget = meta.contextBudgetTokens;
    const newBudget = tokens && tokens > 0 ? tokens : undefined;

    if (previousBudget === newBudget) return;

    setSessionMeta(sessionId, { ...meta, contextBudgetTokens: newBudget });

    const { toolFactory, excludedTools } = active;
    try {
      await active.session.disconnect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[CTXWIN] disconnect during budget change failed: ${msg}`);
    }
    dispatchState.end(sessionId);
    this.activeSessions.delete(sessionId);

    try {
      await this.resume(sessionId, { toolFactory, excludedTools });
      console.log(`[CTXWIN] Recreated session ${sessionId.slice(0, 8)} with budget ${newBudget ?? 'default'}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Restore the previous meta budget, then attempt to bring the session back.
      const cur = getSessionMeta(sessionId) ?? { name: '' };
      setSessionMeta(sessionId, { ...cur, contextBudgetTokens: previousBudget });
      try {
        await this.resume(sessionId, { toolFactory, excludedTools });
        console.warn(`[CTXWIN] Budget change failed; reverted ${sessionId.slice(0, 8)} to ${previousBudget ?? 'default'}`);
        throw new Error(`Context budget change failed (${msg}); reverted`);
      } catch (rollbackErr) {
        const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`Context budget change failed (${msg}) and rollback failed (${rmsg}); session ended`);
      }
    }
  }

  async compactSession(sessionId: string, customInstructions?: string): Promise<{ tokensRemoved: number; messagesRemoved: number }> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    const instr = customInstructions?.trim();
    const result = await active.session.rpc.history.compact(instr ? { customInstructions: instr } : undefined);
    if (!result.success) {
      throw new Error('Compaction failed');
    }
    console.log(`[COMPACT] Session ${sessionId.slice(0, 8)}: removed ${result.tokensRemoved} tokens, ${result.messagesRemoved} messages`);
    return { tokensRemoved: result.tokensRemoved, messagesRemoved: result.messagesRemoved };
  }

  /** Clear stored reasoning effort when switching to a model that doesn't
   *  support it or doesn't include the stored value in supportedReasoningEfforts. */
  private clearStaleReasoningEffort(sessionId: string, newModelId: string): void {
    const meta = getSessionMeta(sessionId);
    if (!meta?.reasoningEffort) return;
    const newModel = this.cachedModels.find(m => m.id === newModelId);
    const supported = newModel?.supportedReasoningEfforts;
    const supportsEffort = newModel?.capabilities?.supports?.reasoningEffort;
    if (!supportsEffort || (supported && !supported.includes(meta.reasoningEffort))) {
      setSessionMeta(sessionId, { ...meta, reasoningEffort: undefined });
    }
  }

  async setSessionReasoningEffort(sessionId: string, effort: string | null): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    const cacoModel = readModelFromEvents(sessionId);
    const modelInfo = cacoModel ? this.cachedModels.find(m => m.id === cacoModel) : undefined;
    if (!modelInfo?.capabilities?.supports?.reasoningEffort) {
      throw new Error('Active model does not support reasoning effort');
    }
    const supported = modelInfo.supportedReasoningEfforts;
    if (effort !== null && supported && !supported.includes(effort)) {
      throw new Error(`Effort "${effort}" not supported by this model. Supported: ${supported.join(', ')}`);
    }
    const effectiveEffort = effort ?? modelInfo.defaultReasoningEffort;
    if (!effectiveEffort) {
      throw new Error('Cannot clear effort: model has no default effort level');
    }
    await active.session.rpc.model.setReasoningEffort({ reasoningEffort: effectiveEffort });
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    if (effort === null || effort === modelInfo.defaultReasoningEffort) {
      const { reasoningEffort: _, ...rest } = meta;
      setSessionMeta(sessionId, rest as typeof meta);
    } else {
      setSessionMeta(sessionId, { ...meta, reasoningEffort: effort });
    }
    console.log(`[EFFORT] Session ${sessionId.slice(0, 8)}: effort=${effort ?? `default (${effectiveEffort})`}`);
  }

  /**
   * Fetch the current quota via account.getQuota RPC and broadcast caco.usage
   * if it changed. Safe to call frequently — pollQuota is single-flight.
   */
  async pollQuota(): Promise<void> {
    if (!this.sharedClient) return;
    await pollQuota(this.sharedClient);
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
    this.resetIdleTimer();
  }

  /**
   * Cancel an active session dispatch.
   * Calls abort(), waits briefly for the SDK to confirm idle, then force-clears if needed.
   * Returns { forced: true } if the SDK didn't confirm within the timeout.
   */
  async cancelSession(sessionId: string): Promise<{ forced: boolean }> {
    const ABORT_TIMEOUT_MS = 10_000;
    const IDLE_WAIT_MS = 5_000;

    const session = this.activeSessions.get(sessionId);

    // Session not in memory but dispatch state says busy — force-clear immediately
    if (!session && this.isBusy(sessionId)) {
      console.warn(`[CANCEL] Session ${sessionId.slice(0, 8)} not in memory, force-clearing dispatch`);
      this.endDispatch(sessionId);
      return { forced: true };
    }

    if (!session) return { forced: false };

    // Call abort with a timeout so we don't hang if the CLI is unresponsive
    try {
      await Promise.race([
        session.session.abort(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('abort timeout')), ABORT_TIMEOUT_MS))
      ]);
    } catch (e) {
      console.error(`[CANCEL] abort() failed for ${sessionId.slice(0, 8)}:`, e instanceof Error ? e.message : e);
    }

    // If not busy anymore, abort worked
    if (!this.isBusy(sessionId)) return { forced: false };

    // Wait briefly for the SDK to emit session.idle/error
    const result = await dispatchState.waitForIdle(sessionId, IDLE_WAIT_MS);
    if (result === 'idle') return { forced: false };

    // SDK didn't confirm — force-clear
    console.warn(`[CANCEL] Force-clearing stuck dispatch for ${sessionId.slice(0, 8)}`);
    this.endDispatch(sessionId);
    return { forced: true };
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
   * Send a message to the SDK session (fire-and-forget).
   * Returns the send promise; callers should attach .catch() but NOT await.
   * Events stream via session.on(), not via the returned promise.
   * @throws Error synchronously if session is not active
   */
  sendStream(sessionId: string, message: string, options: Partial<SendOptions> = {}): Promise<string> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Session ${sessionId} is not active`);
    }
    
    const { session } = active;
    return session.send({
      ...options,
      prompt: message,
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
   * List MCP servers via session RPC. Returns server name, status, source, error.
   * Requires at least one active session. Returns empty array if none available.
   */
  async listMcpServers(): Promise<McpServerInfo[]> {
    const firstSession = this.activeSessions.values().next().value;
    if (!firstSession) return [];
    try {
      const result = await firstSession.session.rpc.mcp.list();
      return result.servers;
    } catch (e) {
      console.error('[MCP] Failed to list MCP servers:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * List all tools via client RPC. Returns tool name, namespacedName, description.
   * Requires a running SDK client. Returns empty array if not available.
   */
  async listAllTools(): Promise<ToolInfo[]> {
    if (!this.sharedClient) return [];
    try {
      const result = await this.sharedClient.rpc.tools.list({});
      return result.tools;
    } catch (e) {
      console.error('[MCP] Failed to list tools:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  isClientRunning(): boolean {
    return this.sharedClient !== null;
  }

  /**
   * Fork an existing session. Returns the new session ID.
   * Uses the SDK's experimental sessions.fork RPC to copy events to a new session.
   * Mirrors the post-creation registration steps that create() does:
   * sessionCache.set, registerSession, ensureSessionMeta.
   *
   * The caller is responsible for writing the new session's caco meta
   * (name, folder, model, parentSessionId, kind) before this returns to the user.
   */
  async forkSession(parentSessionId: string, toEventId?: string): Promise<{ sessionId: string; cwd: string }> {
    const parentRecord = this.sessionCache.get(parentSessionId);
    if (!parentRecord) {
      throw new Error(`Parent session ${parentSessionId} not found`);
    }
    if (!parentRecord.cwd) {
      throw new Error(`Parent session ${parentSessionId} has no cwd`);
    }
    const parentCwd = parentRecord.cwd;
    const client = await this.ensureClient();
    const result = await client.rpc.sessions.fork({ sessionId: parentSessionId, toEventId });
    const newId = result.sessionId;

    // Mirror what create() does for cache registration
    this.sessionCache.set(newId, { cwd: parentCwd, summary: null });
    registerSession(parentCwd, newId);
    ensureSessionMeta(newId);

    return { sessionId: newId, cwd: parentCwd };
  }

  /**
   * Shut down the shared SDK client. Call after all sessions are destroyed.
   */
  async shutdown(): Promise<void> {
    this.stopHealthCheck();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
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

export const sessionManager = new SessionManager();
