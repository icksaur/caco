import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { ProviderConfig, ContextTier } from '@github/copilot-sdk';
import { existsSync, mkdirSync, cpSync, rmSync, mkdtempSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { CreateConfig, ResumeConfig, ResumeResult, SystemMessage, SessionEvent, ToolFactory } from './types.js';
import { ensureSessionMeta, getSessionMeta, updateSessionMeta, readSessionMeta, getSessionIconPath, setSessionOrder, type SessionKind } from './storage.js';
import { getSessionDir } from './storage-paths.js';
import { cancelCardPersist } from './file-edits-store.js';
import { readSessionWorkspace, readSessionEvents, readSessionEventsResult, parseSessionModel, listSessionIds } from './sdk-session-store.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { CorrelationMetrics, DEFAULT_RULES, type CorrelationRules } from './correlation-metrics.js';
import { dispatchState } from './dispatch-state.js';
import { setAnyPendingProvider } from './restart-manager.js';import { pollQuota } from './quota-poller.js';
import type { QuotaSnapshot } from './usage-state.js';
import { loadMcpServers } from './mcp-config-loader.js';
import { createObservationHook } from './observe/hook.js';
import { OBS_RAW_CEILING_BYTES } from './observe/types.js';
import { shouldAutoRepairSessionError, repairSessionEvents } from './session-auto-repair.js';
import { reconcileRotation, autoRotateIfEligible } from './session-history-rotation.js';
import { disposeSessionRuntime } from './session-runtime.js';
import { broadcastEvent } from './event-bus.js';
import { hasProviders, listByokModels, resolveModel } from './provider-registry.js';
import { thresholdForBudget, type ModelTokenLimits } from './context-budget.js';
import { tokenLimitsForModel, effectiveContextTier } from './model-billing.js';
import type { SdkAgentInfo, SdkCommandInfo, SdkCommandInvokeResult } from './agent-command.js';
import { buildToolCatalog, type ToolCatalog } from './tool-catalog.js';
import { builtinKey, cacoKey, type ToolKey } from './tool-key.js';
import { lookupMcpKey, learnFromMetadata, keysForServer, allLearnedKeys } from './tool-key-registry.js';
import { recordObservedSizes, getToolSize } from './tool-size-store.js';
import { estimateToolTokens } from './tool-size.js';
import { validateEnable, resolveEnableTargets, computeColdResumeExclusions, deferredToolKeys } from './session-tool-state.js';
import { excludedBuiltinNames, DEFER_ELIGIBLE_CACO_TOOLS } from './tool-registry.js';
import { getDeferredServers, setServerDeferred } from './manual-defer-store.js';
import { getAutoDeferred, addAutoDeferred, removeAutoDeferred } from './auto-defer-store.js';
import { getNowActiveSeconds, getLastUsedActiveSeconds, stampToolUsage, DEFER_STALE_THRESHOLD_ACTIVE_SECONDS, COLD_RESUME_STALE_MS } from './tool-usage-store.js';
import { getToolsUsed, setDeferredDefsProvider, recordCompaction } from './session-throughput.js';
import { computeDeferredReminder, clearDeferredReminder } from './deferred-reminder-store.js';
import { isHerdParent } from './herd.js';
import { AUTO_CONTINUE_CAP } from './auto-continue.js';


import { formatMemoryForPrompt } from './memory-tool.js';
import { buildSystemMessage, resolveSystemMessage } from './prompts.js';


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
  parameters?: Record<string, unknown>;
  instructions?: string;
}

/** Resolved per-turn tool metadata snapshot (session.tools.getCurrentMetadata).
 *  Carries the input schema — the bulk of a tool's per-turn token weight. */
export interface CurrentToolMetadata {
  name: string;
  namespacedName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  description: string;
  input_schema?: Record<string, unknown>;
  deferLoading?: boolean;
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

interface LargeToolOutputConfig {
  enabled?: boolean;
  maxSizeBytes?: number;
  outputDirectory?: string;
}

export const SDK_LARGE_OUTPUT_MAX_SIZE_BYTES = 20 * 1024;

export function sdkLargeOutputConfig(): LargeToolOutputConfig {
  return { enabled: true, maxSizeBytes: SDK_LARGE_OUTPUT_MAX_SIZE_BYTES };
}

interface CreateSessionConfig {
  model?: string;
  streaming?: boolean;
  systemMessage?: SystemMessage;
  tools?: unknown[];
  excludedTools?: string[];
  provider?: ProviderConfig;
  infiniteSessions?: InfiniteSessionConfig;
  largeOutput?: LargeToolOutputConfig;
  contextTier?: ContextTier;
  configDirectory?: string;
  enableConfigDiscovery?: boolean;
}

interface ResumeSessionConfig {
  streaming?: boolean;
  tools?: unknown[];
  excludedTools?: string[];
  systemMessage?: { mode: 'append' | 'replace'; content: string };
  model?: string;
  reasoningEffort?: string;
  provider?: ProviderConfig;
  infiniteSessions?: InfiniteSessionConfig;
  largeOutput?: LargeToolOutputConfig;
  contextTier?: ContextTier;
  configDirectory?: string;
  enableConfigDiscovery?: boolean;
}

/**
 * Whether a session's resume should reuse the parent's exact `mode:'replace'` system
 * message for fork cache preservation (spec-session-fork). True only for a forked
 * INTERACTIVE child's FIRST genuine activation:
 *   - `parentSessionId` set AND `kind === 'interactive'` — a fork, not a swarm/agent
 *     child (those also set parentSessionId but want their own agent prompt).
 *   - NOT already active — first activation only.
 *   - NOT a warm recreate / model switch — those delete `activeSessions` then resume,
 *     so `!alreadyActive` alone would misfire and bust a warm forked child's cache.
 * Pure so the full gate is unit-testable without a resume harness.
 */
export function shouldUseForkReplaceSystemMessage(
  meta: { parentSessionId?: string; kind?: string } | undefined,
  guards: { alreadyActive: boolean; warmRecreate?: boolean; modelOverride?: string },
): boolean {
  if (guards.alreadyActive || guards.warmRecreate || guards.modelOverride !== undefined) return false;
  return !!meta?.parentSessionId && meta.kind === 'interactive';
}

/**
 * Build the resume-time `systemMessage` for `_doResume` (fork cache preservation,
 * spec-session-fork). A forked interactive child's first activation reuses the
 * parent's exact `mode:'replace'` content (so its prefix matches the parent's cache);
 * every other resume keeps the historical behaviour — a `mode:'append'` memory block
 * when memory is present, else nothing. Pure so the exact object the call site sends
 * to `resumeSession` is unit-testable without a resume harness.
 */
export function resolveResumeSystemMessage(opts: {
  useForkReplace: boolean;
  replaceContent: string;
  memoryContent: string;
}): { mode: 'append' | 'replace'; content: string } | undefined {
  if (opts.useForkReplace) return { mode: 'replace', content: opts.replaceContent };
  if (opts.memoryContent) return { mode: 'append', content: opts.memoryContent };
  return undefined;
}

interface CopilotSessionInstance {
  sessionId: string;
  send(options: SendOptions): Promise<string>;
  sendAndWait(options: SendOptions, timeout?: number): Promise<unknown>;
  getEvents(): Promise<SessionEvent[]>;
  disconnect(): Promise<void>;
  setModel(model: string, options?: { contextTier?: ContextTier }): Promise<void>;
  abort(): Promise<void>;
  rpc: {
    history: {
      compact(params?: unknown): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }>;
    };
    mcp: {
      list(): Promise<{ servers: McpServerInfo[] }>;
      listTools(params: { serverName: string }): Promise<{ tools: { name: string; description?: string }[] }>;
    };
    tools: {
      getCurrentMetadata(): Promise<{ tools: CurrentToolMetadata[] | null }>;
    };
    model: {
      setReasoningEffort(params: { reasoningEffort: string }): Promise<{ reasoningEffort: string }>;
    };
    agent: {
      list(): Promise<{ agents: SdkAgentInfo[] }>;
      select(params: { name: string }): Promise<{ agent: SdkAgentInfo }>;
    };
    commands: {
      list(params?: Record<string, unknown>): Promise<{ commands: SdkCommandInfo[] }>;
      invoke(params: { name: string; input?: string }): Promise<SdkCommandInvokeResult>;
    };
    // Live, no-resume mutation of the session's tool filter (spec-tool-reveal B2).
    // toolFilterPrecedence "excluded" applies the denylist (allow-all-except-X);
    // returns whether the patch was accepted.
    options: {
      update(params: SessionUpdateOptionsPatch): Promise<{ success: boolean }>;
    };
    // Current context-window token breakdown (spec-tool-reveal B0). The MCP-specific
    // mcpToolsTokens lives ONLY here (not on usage events). Params are required;
    // 0 = runtime default. Returns null contextInfo until the session is initialized.
    metadata: {
      contextInfo(params: MetadataContextInfoParams): Promise<{ contextInfo?: SessionContextInfo | null }>;
    };
  };
}

/** Mutable session-options patch accepted by `rpc.options.update` (subset Caco uses). */
interface SessionUpdateOptionsPatch {
  excludedTools?: string[];
  availableTools?: string[];
  toolFilterPrecedence?: 'available' | 'excluded';
}

interface MetadataContextInfoParams {
  promptTokenLimit: number;
  outputTokenLimit: number;
  selectedModel?: string;
}

/** Token breakdown for the current context window (subset Caco reads). `toolDefinitionsTokens`
 *  and `mcpToolsTokens` both EXCLUDE deferred tools — the proof that deferral saves tokens. */
export interface SessionContextInfo {
  conversationTokens: number;
  systemTokens: number;
  toolDefinitionsTokens: number;
  mcpToolsTokens: number;
  totalTokens: number;
  promptTokenLimit: number;
}

interface SendOptions {
  prompt: string;
  attachments?: Array<{ type: string; path: string }>;
  mode?: string;
  displayPrompt?: string;
}

interface ActiveSession {
  cwd: string;
  session: CopilotSessionInstance;
  providerId?: string;
  toolFactory: ToolFactory;
  excludedTools?: string[];
  lastUsedAt: number;
}

/** A Caco-owned tool for the mcp-servers applet catalog. */
export interface CacoToolCatalogEntry {
  name: string;
  description: string;
  hardDisabled: boolean;
  /** JSON-schema form of the tool's parameters (converted from zod at capture),
   *  so the applet can estimate the tool's real per-turn token cost. */
  parameters?: Record<string, unknown>;
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
  /** Herd bond: this session's parent id, or null if not a herd child. */
  orchestratedBy: string | null;
  /** Whether this session is a herd parent (≥1 child claims it — derived). */
  isHerdParent: boolean;
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
    updateSessionMeta(sessionId, meta => {
      if (meta.model !== resolvedModel) meta.model = resolvedModel;
    });
  }
}

/**
 * Resolve a session's Caco model id. Prefers the synced meta cache (set on
 * create/resume); falls back to parsing the SDK event log when meta lacks a
 * model (legacy/imported/external sessions). The fallback's event-log read only
 * runs for those uncached sessions, so it stays off the hot path while keeping
 * tier pinning, budget, and effort consistent on the first resume.
 */
function readModelFromEvents(sessionId: string): string | null {
  const meta = getSessionMeta(sessionId);
  return meta?.model ?? parseSessionModel(sessionId);
}

// ============================================================================

/**
 * SessionManager - Singleton that owns all SDK interactions
 * 
 * Enforces one active session per cwd (working directory).
 * Discovers existing sessions from ~/.copilot/session-state/
 */
export class SessionManager {
  // Correlation tracking for agent runaway guard
  private correlations = new Map<string, CorrelationMetrics>();
  private correlationRules: CorrelationRules = DEFAULT_RULES;
  
  // sessionId → { cwd, session }
  private activeSessions = new Map<string, ActiveSession>();

  // Caco's own defineTool tools (name+description+hardDisabled), captured once at
  // startup by server.ts BEFORE filterDisabledTools, so hard-disabled tools are
  // still enumerable for the mcp-servers applet. See docs/spec-tool-reveal.md.
  private cacoToolCatalog: CacoToolCatalogEntry[] = [];
  
  // sessionId → Promise (serializes concurrent caco_enable_tools reveals so the
  // read-modify-write of excludedTools is atomic; two enables in one turn compose).
  private revealLocks = new Map<string, Promise<unknown>>();

  // Auto-continuation state (spec-enable-tools-autocontinue). Two SEPARATE maps so
  // the cap counter is never lost when the pending tool set is cleared on a fire:
  //  - pendingTools: names revealed this dispatch, to make available in the
  //    continuation dispatch (unioned across multiple reveals in one dispatch).
  //  - autoContinueAttempts: consecutive auto-continuations fired, reset only by a
  //    non-autocontinue (human/agent/applet/scheduler) dispatch start.
  private pendingTools = new Map<string, Set<string>>();
  // sessionId → the hop-count depth of the dispatch that revealed the pending tools,
  // captured while that dispatch is live (spec-herd-depth-breadth). The auto-continue
  // dispatch — a same-session continuation, NOT a root — carries this so nested work
  // cannot regain delegation budget by revealing a tool.
  private pendingToolsDepth = new Map<string, number>();
  private autoContinueAttempts = new Map<string, number>();
  // Sessions whose continuation is being SET UP (spec-idle-suppression-central):
  // held by the auto-continue runtime from before the pending set is cleared until
  // startDispatch registers the continuation, so the restart gate keeps deferring
  // across that sub-window. Kept OUT of hasPendingAutoContinue (the dispatchState idle
  // suppressor) so the continuation's own end() still emits a real idle.
  private continuationInFlight = new Set<string>();

  // sessionId → { cwd, summary } (cached from disk)
  private sessionCache = new Map<string, CachedSession>();
  
  // sessionId → Promise (serializes concurrent resume attempts)
  private resumeInProgress = new Map<string, Promise<ResumeResult>>();
  
  // sessionId → Promise (history rotation in progress; resume waits on it)
  private rotatingSessions = new Map<string, Promise<unknown>>();
  
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
      process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = String(OBS_RAW_CEILING_BYTES);
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
      this.dropActiveSessions(true);
      if (client) client.forceStop().catch(() => {});
    }
  }

  /**
   * Drop every active session as one unit: end its dispatch, dispose its
   * runtime (queue + throughput + usage), and forget it. When `notify`, tell the
   * FE the in-flight turn was reset so it doesn't sit on a dead dispatch.
   *
   * Returns the affected session ids. The SDK-level `_clientSessions` view
   * pointers in SessionState are deliberately left intact — the next access
   * re-resumes the session from disk; this only clears volatile runtime state.
   */
  private dropActiveSessions(notify: boolean): string[] {
    const affected = [...this.activeSessions.keys()];
    this.activeSessions.clear();
    for (const id of affected) {
      dispatchState.end(id);
      disposeSessionRuntime(id);
      if (notify) {
        broadcastEvent(id, {
          type: 'session.error',
          data: { message: 'Session was reset due to a connection issue — please retry your last message.', restorePrompt: true },
        } as SessionEvent);
      }
    }
    if (affected.length > 0) {
      console.warn(`[SDK] Dropped ${affected.length} active session(s) on client restart`);
    }
    return affected;
  }

  /**
   * Tear down the shared client and drop all active sessions as one transaction.
   * `graceful` uses client.stop() (idle teardown) rather than forceStop(); the
   * client is NOT re-established here — callers that need it warm call
   * ensureClient() afterwards.
   */
  private async restartSharedClient(opts: { notify: boolean; graceful?: boolean }): Promise<void> {
    this.stopHealthCheck();
    const client = this.sharedClient;
    this.sharedClient = null;
    this.dropActiveSessions(opts.notify);
    if (client) {
      try { await (opts.graceful ? client.stop() : client.forceStop()); } catch { /* already dead */ }
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
      await this.restartSharedClient({ notify: true });
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
      void this.restartSharedClient({ notify: false, graceful: true });
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
      await this.restartSharedClient({ notify: true });
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
      await this.restartSharedClient({ notify: true });
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
    return tokenLimitsForModel(m);
  }

  /**
   * The context tier to pin for a model. Returns 'long_context' only when that
   * tier is a free upgrade (price-equal to default); otherwise 'default'.
   * Returns undefined when the model is unknown so callers omit the option and
   * let the SDK default stand. Single source of truth shared by create, resume,
   * and in-place model switch so the pinned window always matches billing.
   */
  contextTierFor(cacoModelId: string | undefined): ContextTier | undefined {
    if (!cacoModelId) return undefined;
    const m = this.cachedModels.find(x => x.id === cacoModelId);
    if (!m) return undefined;
    return effectiveContextTier(m);
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
      // A rotation that crashed mid-swap may have left this session with its
      // events.jsonl renamed aside (no events.jsonl on disk). Reconcile from the
      // sidecars BEFORE the events read below, or the session would look missing
      // and silently vanish. Cheap (two existsSync) when nothing is pending.
      const recovery = reconcileRotation(sessionId);
      if (recovery !== 'clean') console.warn(`[DISCOVER] Rotation recovery for ${sessionId}: ${recovery}`);

      const record: CachedSession = { cwd: null, summary: null };

      const eventsResult = readSessionEventsResult(sessionId);
      if (!eventsResult.ok && eventsResult.kind === 'missing') continue;

      if (eventsResult.ok) {
        const events = eventsResult.value;
        if (events.length === 0) continue;

        const startEvent = events[0];
        if (startEvent.type === 'session.start') {
          const ctx = startEvent.data?.context as Record<string, unknown> | undefined;
          record.cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : null;
        }
      } else {
        // Corrupt events file: a transient read failure or all-malformed JSONL
        // must not erase a real session from the UI. Register it anyway, deriving
        // cwd from the meta override or workspace, and log loudly.
        console.error(`[DISCOVER] Corrupt events for ${sessionId}; registering with fallback cwd (${eventsResult.error.message})`);
        record.cwd = readSessionWorkspace(sessionId)?.cwd ?? null;
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
    // Seed exclusions = base (builtins) ∪ operator manual-defer preference (Phase D) ∪
    // new-session auto-defer (Phase C3). A brand-new session has no prompt-cache prefix,
    // so applying the system-wide staleness verdict here is free — this is why a
    // short-lived process that never goes cold still gets lean sessions.
    const seededExclusions = [...new Set<string>([
      ...(config.excludedTools ?? []),
      ...this.manualDeferredKeys(),
      ...this.computeNewSessionAutoDefer(),
    ])];
    
    let session: CopilotSessionInstance;
    try {
      session = await client.createSession({
        model: resolved.sdkModel,
        streaming: true,
        systemMessage: config.systemMessage,
        tools,
        excludedTools: seededExclusions,
        onPermissionRequest: approveAll,
        // configDirectory is the SDK's public option name (it maps internally to
        // the wire field configDir). Passing `configDir` here was silently dropped,
        // so the SDK fell back to its ~/.copilot default; name it correctly so the
        // config root is actually pinned.
        configDirectory: join(homedir(), '.copilot'),
        // Parity with the Copilot CLI (which enables this by default): discover
        // file-based custom agents (~/.copilot/agents, <cwd>/.github/agents), skills
        // (~/.copilot/skills), and project MCP configs (.mcp.json/.vscode/mcp.json),
        // merged with the explicit mcpServers below (explicit wins on name
        // collision). This is what makes Spec Kit's `/agent speckit.*` commands and
        // user-installed agents/skills work in a Caco session. Note: it also
        // auto-loads a project's MCP config — acceptable under Caco's existing
        // approveAll trust posture (the user explicitly chose this cwd).
        enableConfigDiscovery: true,
        mcpServers: await loadMcpServers(),
        workingDirectory: cwd,
        largeOutput: sdkLargeOutputConfig(),
        hooks: { onPostToolUse: createObservationHook(cwd, sessionRef) },
        ...(resolved.provider && { provider: resolved.provider }),
        ...(this.contextTierFor(resolved.cacoId) && { contextTier: this.contextTierFor(resolved.cacoId) }),
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
      excludedTools: seededExclusions,
      lastUsedAt: Date.now(),
    });
    this.sessionCache.set(session.sessionId, { cwd, summary: null });
    
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
    // Wait out any in-progress history rotation so we resume against the
    // post-swap file, never a half-rotated one.
    const rotation = this.rotatingSessions.get(sessionId);
    if (rotation) {
      console.log(`[RESUME] Waiting for in-progress rotation of ${sessionId}`);
      await rotation;
    }

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
   * Run an exclusive history-rotation operation for a session. Refuses if the
   * session is active, busy, or already rotating. While it runs, resume() waits
   * on it so a rotation and a resume never race on the same events.jsonl.
   */
  async runExclusiveRotation<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    if (this.activeSessions.has(sessionId)) throw new Error(`Cannot rotate active session ${sessionId}`);
    if (this.isBusy(sessionId)) throw new Error(`Cannot rotate busy session ${sessionId}`);
    if (this.rotatingSessions.has(sessionId)) throw new Error(`Rotation already in progress for ${sessionId}`);
    // A resume in flight is invisible to activeSessions until AFTER the multi-second
    // SDK read of events.jsonl (_doResume sets activeSessions only at the end), but it
    // is reading the very file we would swap. resumeInProgress is set synchronously at
    // resume() entry, before any await, so checking it closes that window.
    if (this.resumeInProgress.has(sessionId)) throw new Error(`Cannot rotate session ${sessionId} while a resume is in flight`);

    const promise = op();
    this.rotatingSessions.set(sessionId, promise.catch(() => {}));
    try {
      return await promise;
    } finally {
      this.rotatingSessions.delete(sessionId);
    }
  }

  isRotating(sessionId: string): boolean {
    return this.rotatingSessions.has(sessionId);
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
    const existingActive = this.activeSessions.get(sessionId);
    if (existingActive) {
      existingActive.lastUsedAt = Date.now();
      console.log(`Session ${sessionId} already active`);
      return { sessionId, usedFallbackCwd };
    }
    
    const tDoStart = performance.now();
    const tEnsure0 = performance.now();
    const client = await this.ensureClient();
    const tEnsure = performance.now() - tEnsure0;
    
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
    // Fork cache preservation: a forked child copies the parent's system.message event
    // into its history at fork time, and on a plain resume the runtime ALSO generates
    // its own default foundation prompt — a double system message (~2x tokens, 0%
    // cache). For a forked INTERACTIVE child's first (cold) resume, pass the SAME
    // mode:'replace' content the parent was created with, so the runtime's system block
    // matches the parent's cached [replace-sys] prefix (fresh-billed tokens drop, cache
    // prefix restored). Gate on kind==='interactive': swarm/agent children ALSO set
    // parentSessionId but want their own agent prompt, so they must NOT be caught here.
    const forkMeta = getSessionMeta(sessionId);
    const useForkReplace = shouldUseForkReplaceSystemMessage(forkMeta, {
      alreadyActive: !!existingActive,
      warmRecreate: config.warmRecreate,
      modelOverride: config.modelOverride,
    });
    const resumeSystemMessage = resolveResumeSystemMessage({
      useForkReplace,
      // Only rebuild the ~13k replace prompt when we actually need it (forked child).
      replaceContent: useForkReplace ? resolveSystemMessage(await buildSystemMessage(), cwd).content : '',
      memoryContent,
    });
    const tMcp0 = performance.now();
    const mcpServers = await loadMcpServers();
    const tMcp = performance.now() - tMcp0;
    // Seed exclusions = base (builtins from config) ∪ operator manual-defer preference
    // (Phase D) ∪ cold-resume auto-defer (Phase C2). Manual defer is re-applied on every
    // resume so a manually-deferred server stays hidden across restarts. Auto-defer fires
    // ONLY on a genuinely cold resume (see computeColdResumeAutoDefer) — free because the
    // provider prefix cache is already evicted — and never on a warm recreate/model-switch.
    const autoDeferred = this.computeColdResumeAutoDefer(sessionId, config);
    const seededExclusions = [...new Set<string>([
      ...(config.excludedTools ?? []),
      ...this.manualDeferredKeys(),
      ...autoDeferred,
    ])];
    const resumeArgs = {
      streaming: true,
      tools,
      excludedTools: seededExclusions,
      onPermissionRequest: approveAll,
      // See createSession: correct option name + enable file-based agent/skill/MCP
      // discovery so resumed sessions keep parity with the Copilot CLI.
      configDirectory: join(homedir(), '.copilot'),
      enableConfigDiscovery: true,
      mcpServers,
      workingDirectory: cwd,
      largeOutput: sdkLargeOutputConfig(),
      hooks: { onPostToolUse: createObservationHook(cwd, sessionRef) },
      ...(resumeSystemMessage && { systemMessage: resumeSystemMessage }),
      ...(applyModel && { model: resolved.sdkModel }),
      ...(resolved?.provider && { provider: resolved.provider }),
      ...(infinite && { infiniteSessions: infinite }),
      ...(applyEffort && { reasoningEffort: storedEffort }),
      ...(this.contextTierFor(cacoModel ?? undefined) && { contextTier: this.contextTierFor(cacoModel ?? undefined) }),
    } as ResumeSessionConfig;

    const MAX_REPAIR_ATTEMPTS = 3;
    let lastFailureSignature: string | null = null;
    let attemptedSession: CopilotSessionInstance | null = null;
    let lastError: unknown = null;
    const tSdk0 = performance.now();
    let sdkAttempts = 0;

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      try {
        sdkAttempts++;
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
    const tSdk = performance.now() - tSdk0;
    this.activeSessions.set(sessionId, {
      cwd,
      session,
      providerId: resolved?.providerId,
      toolFactory: config.toolFactory,
      excludedTools: seededExclusions,
      lastUsedAt: Date.now(),
    });
    
    // Evict oldest inactive sessions if over the limit
    const tEvict0 = performance.now();
    await this.evictInactiveSessions();
    const tEvict = performance.now() - tEvict0;
    
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
    // Cold-open latency attribution. ensureClient = first-call SDK client init;
    // mcp = loadMcpServers; sdkResume = SDK resumeSession (events.jsonl
    // rehydration, the dominant cost on large sessions); evict = stopping LRU
    // sessions; prework = model/meta lookups (readModelFromEvents parses the
    // events file when meta is absent). attempts>1 means auto-repair ran.
    const tTotal = performance.now() - tDoStart;
    const tPrework = tTotal - tEnsure - tMcp - tSdk - tEvict;
    console.log(
      `[PERF] _doResume ${sessionId.slice(0, 8)} ensureClient=${tEnsure.toFixed(1)}ms ` +
      `mcp=${tMcp.toFixed(1)}ms sdkResume=${tSdk.toFixed(1)}ms evict=${tEvict.toFixed(1)}ms ` +
      `prework=${tPrework.toFixed(1)}ms total=${tTotal.toFixed(1)}ms attempts=${sdkAttempts}`,
    );
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
    disposeSessionRuntime(sessionId);
    console.log(`[SDK] Dropped stale session ${sessionId} from active map`);
  }

  /**
   * Best-effort abort of the ORIGINAL in-flight generation before a dispatch
   * retry drops+resumes+resends it. A cold session that merely stalled (no first
   * event within the watchdog window) may still be running server-side and
   * writing to events.jsonl; without this abort the original and the retry both
   * persist, doubling the transcript on every later replay. Bounded by a timeout.
   *
   * Returns true when it is SAFE to resend — the original was stopped or was
   * already absent (nothing writing). Returns false when a live session was
   * present but we could NOT confirm it stopped (abort threw/timed out): the
   * caller must then NOT resend, because a second writer would contaminate
   * events.jsonl. Leaving the single original writer in place is correct.
   */
  async abortStaleGeneration(sessionId: string): Promise<boolean> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return true; // absent — nothing is writing, safe to resend
    const ABORT_TIMEOUT_MS = 5_000;
    try {
      await Promise.race([
        active.session.abort(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('abort timeout')), ABORT_TIMEOUT_MS)),
      ]);
      console.log(`[RETRY] Aborted stale generation for ${sessionId.slice(0, 8)} before retry`);
      return true;
    } catch (e) {
      console.warn(`[RETRY] abort of stale generation for ${sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
      return false; // could not confirm the original stopped — unsafe to resend
    }
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
    
    const { session } = active;
    
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
    
    disposeSessionRuntime(sessionId);
    
    console.log(`✓ Stopped session ${sessionId}`);

    // Phase 2: the session is now at rest. Auto-rotate its history if eligible
    // (gated, size+cooldown pre-checked). Fire-and-forget; .catch keeps a
    // background maintenance task from ever surfacing as an unhandled rejection.
    void autoRotateIfEligible(sessionId).catch(() => {});
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

    // Persist the override to Caco meta so it survives restart. The SDK's
    // session.start event keeps the original cwd; _discoverSessions prefers
    // this override when rebuilding the cache.
    if (!updateSessionMeta(sessionId, meta => { meta.cwd = newCwd; })) {
      throw new Error(`Cannot change CWD: session metadata for ${sessionId} is unreadable`);
    }

    console.log(`✓ Changed CWD for ${sessionId}: ${oldCwd} → ${newCwd}`);
  }

  /**
   * Evict oldest inactive sessions when over MAX_ACTIVE_SESSIONS.
   * Only evicts sessions that are not currently busy (not dispatching).
   * Called after resume() adds a new active session.
   */
  private async evictInactiveSessions(): Promise<void> {
    if (this.activeSessions.size <= SessionManager.MAX_ACTIVE_SESSIONS) return;

    // Candidates are sessions that are not currently dispatching, ordered
    // least-recently-used first so an old-but-active session outlives a newer
    // one that hasn't been touched.
    const candidates = [...this.activeSessions.entries()]
      .filter(([id]) => !dispatchState.isBusy(id))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
      .map(([id]) => id);

    const toEvict = Math.min(this.activeSessions.size - SessionManager.MAX_ACTIVE_SESSIONS, candidates.length);
    for (let i = 0; i < toEvict; i++) {
      const id = candidates[i];
      console.log(`[EVICT] Stopping inactive session ${id} (${this.activeSessions.size} active, max ${SessionManager.MAX_ACTIVE_SESSIONS})`);
      try {
        await this.stop(id);
      } catch (err) {
        console.warn(`[EVICT] Failed to stop session ${id}:`, err instanceof Error ? err.message : err);
      }
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
    active.lastUsedAt = Date.now();
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

  async listAgents(sessionId: string): Promise<SdkAgentInfo[]> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error(`Session ${sessionId} is not active`);
    const result = await active.session.rpc.agent.list();
    return result.agents;
  }

  async selectAgent(sessionId: string, name: string): Promise<SdkAgentInfo> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error(`Session ${sessionId} is not active`);
    const result = await active.session.rpc.agent.select({ name });
    return result.agent;
  }

  async listCommands(sessionId: string): Promise<SdkCommandInfo[]> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error(`Session ${sessionId} is not active`);
    const result = await active.session.rpc.commands.list({});
    return result.commands;
  }

  async invokeCommand(sessionId: string, name: string, input?: string): Promise<SdkCommandInvokeResult> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error(`Session ${sessionId} is not active`);
    return active.session.rpc.commands.invoke({ name, input });
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
    this.resetAutoContinue(sessionId);
    disposeSessionRuntime(sessionId);

    // Remove the whole Caco per-session directory (meta.json, files-cards.json,
    // surface.json, chat-draft.txt, outputs/, …). client.deleteSession only
    // removes the SDK dir; without this every Caco per-session file leaks on
    // delete. archive() already does the same rmSync for its own teardown.
    // Cancel the files-applet debounced card write FIRST: a timer firing after
    // rmSync would setSessionData → ensureDir and resurrect a ghost directory.
    cancelCardPersist(sessionId);
    const cacoDir = getSessionDir(sessionId);
    if (existsSync(cacoDir)) {
      try {
        rmSync(cacoDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[delete] failed to remove Caco session dir ${cacoDir}:`, e);
      }
    }
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

      const cacoPath = getSessionDir(sessionId);
      if (existsSync(cacoPath)) {
        cancelCardPersist(sessionId);
        rmSync(cacoPath, { recursive: true });
      }

      this.sessionCache.delete(sessionId);
      this.resetAutoContinue(sessionId);
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
      result.push({ sessionId, cwd, model, name, kind, summary, updatedAt, isBusy, isUnobserved, currentIntent, contextFiles, hasIcon, scheduleSlug, scheduleNextRun, folder: meta?.folder, orchestratedBy: meta?.orchestratedBy ?? null, isHerdParent: isHerdParent(sessionId) });
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

    // Preflight: a model switch mutates the live SDK session, but syncModelCache
    // persists the new model best-effort. If meta.json is corrupt that persistence
    // would be silently refused, leaving the live session ahead of disk (model
    // reverts on restart). Refuse before touching the SDK session instead.
    const metaCheck = readSessionMeta(sessionId);
    if (!metaCheck.ok && metaCheck.kind === 'corrupt') {
      throw new Error(`Cannot change model: session metadata for ${sessionId} is unreadable`);
    }

    this.clearStaleReasoningEffort(sessionId, model);

    if (fastPath) {
      const tier = this.contextTierFor(resolved.cacoId);
      await active.session.setModel(resolved.sdkModel, tier ? { contextTier: tier } : undefined);
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
      await this.resume(sessionId, { toolFactory, excludedTools, modelOverride: model, warmRecreate: true });
      console.log(`[MODEL] Recreated session ${sessionId.slice(0, 8)} on ${model} (provider switch from ${active.providerId ?? 'github'})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (previousModel && previousModel !== model) {
        try {
          await this.resume(sessionId, { toolFactory, excludedTools, modelOverride: previousModel, warmRecreate: true });
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

    const newBudget = tokens && tokens > 0 ? tokens : undefined;
    let previousBudget: number | undefined;
    let changed = false;
    const persisted = updateSessionMeta(sessionId, meta => {
      previousBudget = meta.contextBudgetTokens as number | undefined;
      if (previousBudget === newBudget) return;
      changed = true;
      meta.contextBudgetTokens = newBudget;
    });
    if (!persisted) {
      throw new Error(`Cannot change context budget: session metadata for ${sessionId} is unreadable`);
    }
    if (!changed) return;

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
      await this.resume(sessionId, { toolFactory, excludedTools, warmRecreate: true });
      console.log(`[CTXWIN] Recreated session ${sessionId.slice(0, 8)} with budget ${newBudget ?? 'default'}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Restore the previous meta budget, then attempt to bring the session back.
      updateSessionMeta(sessionId, meta => { meta.contextBudgetTokens = previousBudget; });
      try {
        await this.resume(sessionId, { toolFactory, excludedTools, warmRecreate: true });
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
    // The workflow "lean" compound base assumes avoided context still inflates the window
    // every turn; compaction ends that, so reset the forward base (spec-workflow-savings-model
    // item 4). Manual seam — a standalone RPC outside the dispatch event loop.
    recordCompaction(sessionId);
    clearDeferredReminder(sessionId);
    return { tokensRemoved: result.tokensRemoved, messagesRemoved: result.messagesRemoved };
  }

  /** Clear stored reasoning effort when switching to a model that doesn't
   *  support it or doesn't include the stored value in supportedReasoningEfforts. */
  private clearStaleReasoningEffort(sessionId: string, newModelId: string): void {
    updateSessionMeta(sessionId, meta => {
      if (!meta.reasoningEffort) return;
      const newModel = this.cachedModels.find(m => m.id === newModelId);
      const supported = newModel?.supportedReasoningEfforts;
      const supportsEffort = newModel?.capabilities?.supports?.reasoningEffort;
      if (!supportsEffort || (supported && !supported.includes(meta.reasoningEffort as string))) {
        meta.reasoningEffort = undefined;
      }
    }, { createIfMissing: false });
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
    const persisted = updateSessionMeta(sessionId, meta => {
      if (effort === null || effort === modelInfo.defaultReasoningEffort) {
        delete meta.reasoningEffort;
      } else {
        meta.reasoningEffort = effort;
      }
    });
    if (!persisted) {
      throw new Error(`Reasoning effort changed on the live session but could not be persisted: metadata for ${sessionId} is unreadable`);
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

  /** Session ids known on disk/in cache. For maintenance sweeps (history
   *  rotation); does not imply the session is active. */
  knownSessionIds(): string[] {
    return Array.from(this.sessionCache.keys());
  }

  /** A resume is in flight for this session (set synchronously at resume()
   *  entry, before the multi-second SDK read). Used to avoid rotating/cooling
   *  down a session that is being opened. */
  isResuming(sessionId: string): boolean {
    return this.resumeInProgress.has(sessionId);
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
  startDispatch(sessionId: string, correlationId: string, depth = 1): void {
    dispatchState.start(sessionId, correlationId, depth);
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

    // Clear-before-abort (spec-idle-suppression-central): a user cancel must not be
    // held open by a pending reveal-continuation. Reset auto-continue state BEFORE
    // abort() so the idle suppressor returns false — otherwise the SDK's post-abort
    // idle would be suppressed and waitForIdle below would hang until force-clear.
    this.resetAutoContinue(sessionId);

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

  /** The hop-count depth of a session's active dispatch, or undefined if idle.
   *  The route reads the CALLER's depth here to derive an agent call's depth
   *  (spec-herd-depth-breadth). */
  getDispatchDepth(sessionId: string): number | undefined {
    return dispatchState.getDepth(sessionId);
  }

  /**
   * Check if a session has messages (i.e., can be resumed)
   */
  hasMessages(sessionId: string): boolean {
    const result = readSessionEventsResult(sessionId);
    // Corrupt (unreadable but present) → treat as having messages so auto-resume
    // does not skip a session whose history merely failed to read.
    if (!result.ok) return result.kind === 'corrupt';
    return result.value.length > 1;
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
    active.lastUsedAt = Date.now();
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
  async listMcpServers(sessionId?: string): Promise<McpServerInfo[]> {
    const target = sessionId ? this.activeSessions.get(sessionId) : this.activeSessions.values().next().value;
    if (!target) return [];
    try {
      const result = await target.session.rpc.mcp.list();
      return result.servers;
    } catch (e) {
      console.error('[MCP] Failed to list MCP servers:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** Register Caco's own tool catalog (name+description+hardDisabled), captured
   *  once at startup before filterDisabledTools. Used by the mcp-servers applet. */
  setCacoToolCatalog(entries: CacoToolCatalogEntry[]): void {
    this.cacoToolCatalog = entries;
  }

  /** The registered Caco tool catalog for the mcp-servers applet. */
  getCacoToolCatalog(): CacoToolCatalogEntry[] {
    return this.cacoToolCatalog;
  }

  /**
   * List Caco's built-in (model) tools via client RPC, with full metadata
   * (parameters + instructions) so their per-turn token cost is accurate. These
   * are surfaced as the synthetic "Built-in" pseudo-server. ONLY sanctioned use of
   * client `tools.list` — MCP-server tools come from `listMcpTools`. Empty on error.
   */
  async listBuiltinTools(): Promise<{ name: string; description: string; parameters?: Record<string, unknown>; instructions?: string }[]> {
    if (!this.sharedClient) return [];
    try {
      const result = await this.sharedClient.rpc.tools.list({});
      return result.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters,
        instructions: t.instructions,
      }));
    } catch (e) {
      console.error('[MCP] Failed to list built-in tools:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * Resolved per-turn tool metadata (session.tools.getCurrentMetadata) — the
   * OBSERVED set, carrying `input_schema`. Deferred/unloaded tools are absent
   * until a request loads them. Empty on no session/error/uninitialized. Reads the
   * given session when `sessionId` is provided (so callers that scope other queries
   * to a target session learn keys from the SAME session), else the most-recent.
   */
  async getCurrentToolMetadata(sessionId?: string): Promise<CurrentToolMetadata[]> {
    const active = sessionId ? this.activeSessions.get(sessionId) : this.mostRecentActiveSession()?.active;
    if (!active) return [];
    try {
      const result = await active.session.rpc.tools.getCurrentMetadata();
      return result.tools ?? [];
    } catch (e) {
      console.error('[MCP] Failed to get current tool metadata:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * The most-recently-used active session (max lastUsedAt, bumped every send/
   * sendStream), or null if none. The mcp-servers applet is global but reflects a
   * single session; picking the most-recent one shows the session the operator is
   * actually working in — NOT an arbitrary first-inserted (possibly idle) session,
   * whose live contextInfo would be frozen and whose post-restart throughput is 0.
   */
  private mostRecentActiveSession(): { sessionId: string; active: ActiveSession } | null {
    let best: { sessionId: string; active: ActiveSession } | null = null;
    for (const [sessionId, active] of this.activeSessions) {
      if (!best || active.lastUsedAt > best.active.lastUsedAt) best = { sessionId, active };
    }
    return best;
  }

  /** The most-recently-used active session's id (or null). Public so route/catalog
   *  callers can thread ONE consistent target session through listMcpServers +
   *  getCurrentToolMetadata + getContextInfo (avoids mixing sessions when learning keys). */
  mostRecentActiveSessionId(): string | null {
    return this.mostRecentActiveSession()?.sessionId ?? null;
  }

  /**
   * Ground-truth context-window token breakdown (session.metadata.contextInfo) for
   * the most-recently-used active session — the SDK's OWN accounting, where
   * `toolDefinitionsTokens` and `mcpToolsTokens` EXCLUDE deferred tools
   * (spec-tool-reveal B0: the live proof that deferral shrinks the tool block).
   * Returns the sessionId it read from so the caller can pair it with that session's
   * cache-write throughput. `contextInfo` is null when there is no active session,
   * the session is uninitialized (no cached system prompt/tool metadata yet), or the
   * RPC errors.
   */
  async getContextInfo(): Promise<{ sessionId: string | null; contextInfo: SessionContextInfo | null }> {
    const recent = this.mostRecentActiveSession();
    if (!recent) return { sessionId: null, contextInfo: null };
    try {
      // Params required; 0 = runtime default. Result carries a nullable contextInfo
      // (null until the session initializes its system prompt + tool metadata).
      const result = await recent.active.session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit: 0 });
      return { sessionId: recent.sessionId, contextInfo: result.contextInfo ?? null };
    } catch (e) {
      console.error('[MCP] Failed to get context info:', e instanceof Error ? e.message : e);
      return { sessionId: recent.sessionId, contextInfo: null };
    }
  }

  /**
   * List the tools exposed by ONE connected MCP server, via the session-scoped
   * `mcp.listTools` RPC. (Client-level `tools.list` returns built-in model tools,
   * NOT MCP server tools — see docs/spec-mcp-servers.md.) Empty on no session/error.
   */
  async listMcpTools(serverName: string, sessionId?: string): Promise<{ name: string; description: string }[]> {
    const target = sessionId ? this.activeSessions.get(sessionId) : this.activeSessions.values().next().value;
    if (!target) return [];
    try {
      const result = await target.session.rpc.mcp.listTools({ serverName });
      return result.tools.map(t => ({ name: t.name, description: t.description ?? '' }));
    } catch (e) {
      console.error(`[MCP] Failed to list tools for ${serverName}:`, e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * Assemble the unified ToolCatalog (via the single `buildToolCatalog`) + the current
   * exclusion set, for the tool-reveal catalog (`caco_docs section="tools"`). Gathers
   * Caco tools (captured at startup), SDK builtins, and every connected MCP server's
   * tools. `excluded` is the process-level builtin exclusion set as ToolKeys; live
   * session-level MCP exclusions join it in a later phase.
   */
  async getToolCatalog(sessionId?: string): Promise<{ catalog: ToolCatalog; excluded: Set<ToolKey>; policyDisabled: Set<ToolKey> }> {
    // Resolve ONE target session and thread it through every query below, so key
    // learning (from that session's getCurrentToolMetadata) matches the MCP tools we
    // list — otherwise a tool loaded in the target session could be omitted because a
    // DIFFERENT session's metadata was inspected.
    const target = sessionId ?? this.mostRecentActiveSessionId() ?? undefined;
    const mcpServers = await this.listMcpServers(target);
    const listedBuiltins = await this.listBuiltinTools();
    // Learn model-facing MCP keys from the resolved metadata of currently-loaded tools
    // (the authoritative source) before resolving the catalog. Persisted keys cover
    // previously-observed tools that are now deferred/absent.
    const observed = await this.getCurrentToolMetadata(target);
    learnFromMetadata(observed);
    recordObservedSizes(observed);
    const mcp = await Promise.all(
      mcpServers.map(async s => {
        const raw = await this.listMcpTools(s.name, target);
        // Resolve each raw MCP tool to its discovered model-facing key. If not yet
        // learned, still SHOW it (display-only `server/tool` id, excludable:false) so it
        // never silently vanishes from the catalog/applet — it just can't be deferred
        // until first observed. Never fabricate an exclusion key.
        const tools = raw.map(t => {
          const learned = lookupMcpKey(s.name, t.name);
          return learned
            ? { key: learned, name: t.name, description: t.description, excludable: true }
            : { key: `${s.name}/${t.name}` as ToolKey, name: t.name, description: t.description, excludable: false };
        });
        return { serverName: s.name, tools };
      }),
    );
    // The exclusion set for classifyTool: the target session's live set (already ToolKeys)
    // when a session is given, else the process-level builtin default (`builtin:x` forms).
    const excludedRaw = sessionId
      ? this.getExcludedToolKeys(sessionId).map(k => k as string)
      : excludedBuiltinNames();
    const excluded = new Set<ToolKey>(excludedRaw as ToolKey[]);
    // An excluded BUILTIN that tools.list doesn't return (e.g. the powershell family on a
    // non-Windows host) would otherwise be ABSENT from the catalog rather than shown as
    // deferred. Append bare entries for those (builtin exclusions = `builtin:` forms),
    // deduped against the listed ones. Mirrors the applet.
    const listedKeys = new Set(listedBuiltins.map(t => builtinKey(t.name)));
    const bareExcluded = excludedRaw
      .filter(n => n.startsWith('builtin:'))
      .filter(n => !listedKeys.has(builtinKey(n)))
      .map(n => ({ name: n.replace(/^builtin:/, ''), description: '' }));
    const catalog = buildToolCatalog({
      caco: this.getCacoToolCatalog().map(c => ({
        name: c.name, description: c.description, hardDisabled: c.hardDisabled, parameters: c.parameters,
      })),
      builtins: [...listedBuiltins, ...bareExcluded],
      mcp,
    });
    // Policy-disabled keys = the process-level builtin exclusions (the shell family Caco
    // forces through caco_run_workflow, plus platform-absent builtins). These are
    // permanent app-layer policy: shown 'disabled', never 'deferred', and not
    // re-enableable — distinct from a dynamic session defer. (hardDisabled Caco tools are
    // carried per-entry on the catalog, so they need no separate set.)
    const policyDisabled = new Set<ToolKey>(excludedBuiltinNames() as ToolKey[]);
    return { catalog, excluded, policyDisabled };
  }

  /** The session's current exclusion set as ToolKeys (the live truth; starts as the
   *  seeded builtins, shrinks as caco_enable_tools reveals). Empty for unknown sessions. */
  getExcludedToolKeys(sessionId: string): ToolKey[] {
    const active = this.activeSessions.get(sessionId);
    return (active?.excludedTools ?? []) as ToolKey[];
  }

  /** The change-triggered deferred-tools discovery reminder for this dispatch as a
   *  deferred commit: `{ text, commit }`. `text` is the reminder or null (empty/
   *  unchanged set); `commit()` advances the emission signature and MUST be called
   *  only once the send is in flight, so a pre-send failure can't wedge re-emission.
   *  SYNCHRONOUS and RPC-free: derived from the live in-memory exclusion set minus
   *  policy builtins (the deferred keys ARE the enable identifiers), never
   *  `getToolCatalog()` — so it adds no latency or failure mode to prompt send
   *  (spec-enable-tools-discovery). */
  nextDeferredToolsReminder(sessionId: string): { text: string | null; commit: () => void } {
    const policy = new Set<ToolKey>(excludedBuiltinNames() as ToolKey[]);
    const keys = deferredToolKeys(this.getExcludedToolKeys(sessionId), policy);
    return computeDeferredReminder(sessionId, keys);
  }

  /**
   * The SOLE success-gated live mutator of a session's tool exclusion set. Applies the
   * new set via `rpc.options.update` and updates the stored `ActiveSession.excludedTools`
   * truth ONLY when the SDK reports `{success:true}` — so a throw/false leaves the state
   * (and the model's actual tool set) unchanged, and a failed enable never busts the
   * cache. `ActiveSession.excludedTools` remains the single source of truth (it is what
   * every recreate/model-switch path already re-passes to the SDK), so there is no second
   * copy to drift.
   */
  async setExcludedToolsLive(sessionId: string, excluded: ToolKey[]): Promise<{ success: boolean; error?: string }> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return { success: false, error: 'session is not active' };
    try {
      const result = await active.session.rpc.options.update({ excludedTools: excluded });
      if (result.success) active.excludedTools = excluded;
      return { success: result.success };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The manual-defer seed: the union of learned exclusion keys for every operator-
   *  deferred MCP server (Phase D). Resolved from the persisted registry, so it needs no
   *  active session and picks up any already-learned tool of a deferred server. */
  manualDeferredKeys(): ToolKey[] {
    const keys = new Set<ToolKey>();
    for (const server of getDeferredServers()) for (const k of keysForServer(server)) keys.add(k);
    return [...keys];
  }

  /**
   * The gross per-turn definition tokens CURRENTLY omitted by DYNAMIC deferral for a
   * session (spec-deferred-savings S6). Dynamic = the session's live `excludedTools`
   * MINUS the policy set (`excludedBuiltinNames()`) — only C2 auto-defer / D1 manual
   * defer, never policy-disabled builtins (which were never an avoidable cost). For each
   * dynamic key: a Caco-allowlist tool prices from the local catalog (schema is local, so
   * always known); an MCP tool prices from the persisted observed-size store, or counts
   * as `unknown` if never observed. Returns a GROSS estimate of omitted known definitions
   * — NOT a proven saving; the caller must not fold it into net credits. Pure read of
   * current state (no accumulation): the figure changes only on defer/reveal or when a
   * size is learned.
   */
  deferredDefsSavings(sessionId: string): { deferredDefsTokens: number; deferredDefsCount: number; deferredDefsUnknown: number } {
    const policy = new Set<string>(excludedBuiltinNames());
    const dynamic = this.getExcludedToolKeys(sessionId).filter(k => !policy.has(k as string));
    // Local Caco sizes by cacoKey, so a deferred Caco-allowlist tool is always priced.
    const cacoSizeByKey = new Map<ToolKey, number>();
    for (const c of this.getCacoToolCatalog()) {
      if (c.parameters) cacoSizeByKey.set(cacoKey(c.name), estimateToolTokens({ name: c.name, description: c.description, parameters: c.parameters }));
    }
    let deferredDefsTokens = 0;
    let deferredDefsUnknown = 0;
    for (const key of dynamic) {
      const size = cacoSizeByKey.get(key) ?? getToolSize(key);
      if (size === undefined) deferredDefsUnknown++;
      else deferredDefsTokens += size;
    }
    return { deferredDefsTokens, deferredDefsCount: dynamic.length, deferredDefsUnknown };
  }

  /**
   * Whether a RESUME is "cold" for the purpose of auto-defer (Phase C2). Cold = safe to
   * apply exclusions for free because the provider's prompt-cache prefix is already
   * evicted. Two structural gates (spec coldness signals (1)/(2)):
   *   - An internal warm recreate (`config.warmRecreate`, or a model switch via
   *     `config.modelOverride`) is NEVER cold: it rebuilds a session the user is actively
   *     working in, so auto-defer must not shrink its tool set ("warm/model-switch never
   *     auto-mutated" invariant). Explicit and timing-independent — a stale `lastUsedAt`
   *     on an active session can't misfire it.
   *   - Otherwise cold iff the persisted last activity is older than the provider cache
   *     TTL (`COLD_RESUME_STALE_MS`). A fresh/absent stamp ⇒ NOT cold (conservative: a
   *     recreate right after activity — rotation, dispatch-retry — keeps the full set).
   */
  private isColdResume(sessionId: string, config: ResumeConfig): boolean {
    // Internal warm recreates (model switch, context-budget change) rebuild a session the
    // user is actively working in — never auto-defer them, regardless of lastUsedAt.
    if (config.warmRecreate || config.modelOverride !== undefined) return false;
    const lastUsedIso = getSessionMeta(sessionId)?.lastUsedAt;
    if (!lastUsedIso) return false;
    const lastUsedMs = new Date(lastUsedIso).getTime();
    if (!Number.isFinite(lastUsedMs)) return false;
    return Date.now() - lastUsedMs > COLD_RESUME_STALE_MS;
  }

  /**
   * Shared auto-defer verdict for the two cache-free seams (cold resume, create).
   * MCP auto-defer is a one-way LATCH, not a live function of recency (spec-auto-defer
   * -latch): a currently-STALE MCP tool (unused > 2 active-hours; never-used = maximally
   * stale) is UNIONED into the persisted system-wide auto-defer set (the SET transition —
   * the only place `lastUsed` drives an MCP defer decision), and then the WHOLE MCP latch
   * (not just this seam's fresh-stale set) is returned. So a latched MCP tool stays
   * deferred through later cross-session freshness; a passive reveal-use elsewhere can no
   * longer un-defer it. The latch is cleared ONLY by operator manual un-defer (see
   * setServerDeferred).
   *
   * Caco-allowlist tools are deliberately NOT latched: the only CLEAR path is the
   * per-MCP-server un-defer, and a Caco pseudo-server has no such operator control, so
   * latching them would strand them deferred forever (invariant: latched ⇒ operator-
   * clearable). They stay on the LIVE staleness recompute — their pre-latch behaviour —
   * so cross-session freshness still governs the small fixed Caco set.
   *
   * Staleness is the pure `computeColdResumeExclusions` fed the shared threshold — the
   * SAME math the applet's per-tool `wouldDefer` badge shows. Builtins are omitted
   * (already excluded via the base seed). Calling `getNowActiveSeconds()` advances the
   * shared active clock — an intentional, cap-bounded tick (tool-usage-store
   * MAX_ACTIVE_GAP_SECONDS): rapid repeat calls cannot over-age tools.
   */
  private computeStaleDeferCandidates(usedHere: ReadonlySet<ToolKey>, logLabel: string): ToolKey[] {
    const mcpCandidates = [...new Set(allLearnedKeys())];
    const cacoCandidates = DEFER_ELIGIBLE_CACO_TOOLS.map(n => cacoKey(n));
    const nowActiveSeconds = getNowActiveSeconds();
    const lastUsed = getLastUsedActiveSeconds();
    const staleOf = (tools: ToolKey[]) => computeColdResumeExclusions({
      isCold: true, tools, lastUsed, nowActiveSeconds, threshold: DEFER_STALE_THRESHOLD_ACTIVE_SECONDS,
    });
    // SET: only MCP keys enter the persisted latch. The latch's ONLY CLEAR path is the
    // operator's per-MCP-server un-defer (setServerDeferred), so latching a Caco-allowlist
    // tool — which has no per-server operator control — would strand it deferred forever.
    // Caco tools therefore stay on the LIVE staleness recompute (their pre-latch behaviour):
    // recomputed each seam, never persisted, so cross-session freshness still governs them.
    const staleMcp = staleOf(mcpCandidates);
    addAutoDeferred(staleMcp);
    const staleCacoLive = staleOf(cacoCandidates);
    // Seed = the WHOLE MCP latch (sticky across later freshness) ∪ live-stale Caco tools,
    // minus per-session used-here protection.
    const deferred = [...new Set<ToolKey>([...getAutoDeferred(), ...staleCacoLive])].filter(k => !usedHere.has(k));
    if (deferred.length) {
      console.log(
        `[DEFER] ${logLabel}: deferred=${deferred.length} ` +
        `newlyStaleMcp=${staleMcp.length} mcpLatch=${getAutoDeferred().size} staleCaco=${staleCacoLive.length} ` +
        `keptUsedHere=${usedHere.size} thresholdSec=${DEFER_STALE_THRESHOLD_ACTIVE_SECONDS} clockSec=${Math.round(nowActiveSeconds)}`,
      );
    }
    return deferred;
  }

  /**
   * Cold-resume auto-defer keys (Phase C2): on a genuinely cold resume, the shared
   * staleness verdict minus the resuming session's used-here set. Returns `[]` on a warm
   * resume/model-switch/recreate, so the seed is unchanged. In a fresh process the
   * used-here set is empty (in-memory, per-session) so cold-resume auto-defer is driven by
   * the system-wide staleness verdict alone — an accepted, fully-recoverable footgun (the
   * agent reveals a needed tool in one caco_enable_tools call). See spec risk note.
   */
  private computeColdResumeAutoDefer(sessionId: string, config: ResumeConfig): ToolKey[] {
    if (!this.isColdResume(sessionId, config)) return [];
    return this.computeStaleDeferCandidates(getToolsUsed(sessionId), `cold-resume auto-defer ${sessionId.slice(0, 8)}`);
  }

  /**
   * New-session auto-defer keys (Phase C3): the shared staleness verdict applied at
   * `create()`. A brand-new session has no prompt-cache prefix to bust, so deferral is
   * unconditionally free — there is NO coldness gate here (unlike resume). Used-here is
   * empty (the session does not exist yet); cross-session freshness is still honored via
   * the shared active clock. This is why a short-lived process that never goes cold still
   * gets lean sessions.
   */
  private computeNewSessionAutoDefer(): ToolKey[] {
    return this.computeStaleDeferCandidates(new Set<ToolKey>(), 'new-session auto-defer');
  }

  /**
   * Operator manual defer/undefer of a whole MCP server (Phase D). Persists the
   * system-wide preference, then applies it LIVE to every active session (each warm
   * session pays a one-time cache-bust — the applet tooltip warns of this). Future
   * sessions pick it up via the create/resume seed (`manualDeferredKeys`). Monotonic
   * exception: unlike agent reveal/auto-defer, this MAY shrink a warm session, by
   * explicit operator intent. Returns how many sessions were updated.
   */
  async setServerDeferred(serverName: string, deferred: boolean): Promise<{ affectedSessions: number; failedSessions: string[]; keys: ToolKey[] }> {
    setServerDeferred(serverName, deferred);
    const serverKeys = keysForServer(serverName);
    const keySet = new Set(serverKeys);
    // Un-defer is the ONLY auto-defer-latch CLEAR path: drop the server's keys from the
    // latch, then stamp them freshly-used so the immediate next cache-free seam does not
    // re-latch a tool the operator just enabled (a bounded ~2-active-hour window; see
    // spec-auto-defer-latch). Operator intent legitimately stamps recency — a passive
    // per-session reveal does not.
    if (!deferred) {
      removeAutoDeferred(serverKeys);
      for (const k of serverKeys) stampToolUsage(k);
    }
    let affected = 0;
    const failedSessions: string[] = [];
    for (const [sessionId, active] of this.activeSessions) {
      const current = new Set<ToolKey>((active.excludedTools ?? []) as ToolKey[]);
      const before = current.size;
      if (deferred) for (const k of serverKeys) current.add(k);
      else for (const k of current) if (keySet.has(k)) current.delete(k);
      if (current.size === before) continue; // no change for this session
      const applied = await this.setExcludedToolsLive(sessionId, [...current]);
      if (applied.success) affected++;
      else failedSessions.push(sessionId);
    }
    return { affectedSessions: affected, failedSessions, keys: serverKeys };
  }

  /**
   * Reveal deferred tools for a session (the `caco_enable_tools` path). Resolves the
   * agent's names to ToolKeys, atomically rejects unknown/hard-disabled names, treats
   * already-enabled names as idempotent no-ops (never blocks a partially-redundant
   * batch), then applies the shrunk exclusion set live. Monotonic-within-session: only
   * ever REMOVES from the exclusion set. Serialized per session so two concurrent enables
   * in one assistant message compose instead of clobbering each other (each computes from
   * the latest stored set inside the lock). Returns a structured result for the tool.
   */
  async enableTools(sessionId: string, names: string[]): Promise<
    | { ok: true; enabled: ToolKey[]; alreadyEnabled: ToolKey[] }
    | { ok: false; error: string }
  > {
    // Per-session mutex: chain onto any in-flight reveal so the read-modify-write of
    // excludedTools is atomic across concurrent calls (spec monotonic-within-warm).
    const prior = this.revealLocks.get(sessionId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.enableToolsLocked(sessionId, names));
    this.revealLocks.set(sessionId, run);
    try {
      const result = await run;
      // Record a successful reveal so the idle hook can auto-continue this dispatch
      // in a fresh one where the tools are present (spec-enable-tools-autocontinue).
      if (result.ok && result.enabled.length > 0) {
        this.addPendingTools(sessionId, result.enabled.map(k => k as string));
      }
      return result;
    } finally {
      if (this.revealLocks.get(sessionId) === run) this.revealLocks.delete(sessionId);
    }
  }

  /** Union revealed tool names into this session's pending-continuation set. Captures
   *  the revealing dispatch's depth (live now) so the continuation preserves it. */
  addPendingTools(sessionId: string, names: string[]): void {
    if (names.length === 0) return;
    const set = this.pendingTools.get(sessionId) ?? new Set<string>();
    for (const n of names) set.add(n);
    this.pendingTools.set(sessionId, set);
    this.pendingToolsDepth.set(sessionId, dispatchState.getDepth(sessionId) ?? 1);
  }

  /** The depth the auto-continue dispatch should carry (the revealing dispatch's
   *  depth), or 1 if none captured. Read by runAutoContinue's direct dispatch. */
  getRevealDepth(sessionId: string): number {
    return this.pendingToolsDepth.get(sessionId) ?? 1;
  }

  /** The tools awaiting an auto-continuation for this session (empty if none). */
  getPendingTools(sessionId: string): string[] {
    return [...(this.pendingTools.get(sessionId) ?? [])];
  }

  /** Clear the pending-continuation tool set (called when a continuation fires).
   *  Does NOT touch the attempt counter — the two are independent state. */
  clearPendingTools(sessionId: string): void {
    this.pendingTools.delete(sessionId);
  }

  /** Consecutive auto-continuations fired for this session. */
  getAutoContinueAttempts(sessionId: string): number {
    return this.autoContinueAttempts.get(sessionId) ?? 0;
  }

  /** Increment the consecutive-continuation counter (called when a continuation fires). */
  bumpAutoContinueAttempts(sessionId: string): void {
    this.autoContinueAttempts.set(sessionId, this.getAutoContinueAttempts(sessionId) + 1);
  }

  /** Reset auto-continuation state: clear pending tools AND zero the counter.
   *  Called when a non-autocontinue (human/agent/applet/scheduler) dispatch starts,
   *  so a topic change never triggers a leftover re-prompt and human activity
   *  re-arms the budget. */
  resetAutoContinue(sessionId: string): void {
    this.pendingTools.delete(sessionId);
    this.pendingToolsDepth.delete(sessionId);
    this.autoContinueAttempts.delete(sessionId);
    this.continuationInFlight.delete(sessionId);
  }

  /**
   * Whether a continuation WILL fire on this session's next idle (spec-idle-
   * authority): pending tools exist AND the operator preference is on AND we are
   * under the consecutive-continuation cap. The single source of truth for
   * "this idle is not a real idle" — read by the idle authority (to suppress
   * real-idle effects), the herd hook (to skip the parent wake), and the delegate
   * wait (to keep waiting). Deliberately NOT gated on isBusy: it answers "is this
   * session about to auto-continue?" at the idle boundary where the current
   * dispatch is ending. At/over cap ⇒ false (that idle is real; the cap message
   * fires separately). Pref read via an injected provider so SessionManager needs
   * no session-state/preferences import.
   */
  hasPendingAutoContinue(sessionId: string): boolean {
    if ((this.pendingTools.get(sessionId)?.size ?? 0) === 0) return false;
    if (autoContinuePrefProvider && !autoContinuePrefProvider()) return false;
    return this.getAutoContinueAttempts(sessionId) < AUTO_CONTINUE_CAP;
  }

  /** Whether ANY session is about to auto-continue (spec-idle-suppression-central):
   *  used by restart-manager to defer a graceful restart while a reveal-continuation
   *  is pending OR being set up, since its immediate check bypasses the idle emit. */
  hasAnyPendingAutoContinue(): boolean {
    if (this.continuationInFlight.size > 0) return true;
    for (const sessionId of this.pendingTools.keys()) {
      if (this.hasPendingAutoContinue(sessionId)) return true;
    }
    return false;
  }

  /** Mark a continuation as being set up (auto-continue runtime seam). */
  markContinuationInFlight(sessionId: string): void {
    this.continuationInFlight.add(sessionId);
  }

  /** Release the set-up marker (auto-continue runtime seam). */
  clearContinuationInFlight(sessionId: string): void {
    this.continuationInFlight.delete(sessionId);
  }

  private async enableToolsLocked(sessionId: string, names: string[]): Promise<
    | { ok: true; enabled: ToolKey[]; alreadyEnabled: ToolKey[] }
    | { ok: false; error: string }
  > {
    const active = this.activeSessions.get(sessionId);
    if (!active) return { ok: false, error: 'session is not active' };
    // Session-scoped catalog: MCP tools must come from THIS session, not an arbitrary one.
    const { catalog, policyDisabled } = await this.getToolCatalog(sessionId);
    const resolved = resolveEnableTargets(names, catalog);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    // Read the CURRENT set inside the lock (a prior queued reveal may have shrunk it).
    const current = new Set<ToolKey>(this.getExcludedToolKeys(sessionId));
    // Atomically reject hard-disabled + policy-disabled (not re-enableable); no-op
    // already-enabled; enable the deferred remainder. A mixed batch never blocks the
    // valid reveals.
    const toEnable: ToolKey[] = [];
    const alreadyEnabled: ToolKey[] = [];
    for (const key of resolved.keys) {
      const tool = catalog.get(key);
      if (tool?.hardDisabled || policyDisabled.has(key)) return { ok: false, error: `tool is disabled and not re-enableable: ${key}` };
      if (current.has(key)) toEnable.push(key);
      else alreadyEnabled.push(key);
    }
    if (toEnable.length === 0) {
      // Everything requested is already enabled — no cache-busting mutation needed.
      return { ok: true, enabled: [], alreadyEnabled };
    }
    const validated = validateEnable(toEnable, catalog, current, policyDisabled);
    if (!validated.ok) return { ok: false, error: validated.error };
    const applied = await this.setExcludedToolsLive(sessionId, [...validated.nextExcluded]);
    if (!applied.success) return { ok: false, error: applied.error ?? 'rpc.options.update did not succeed' };
    return { ok: true, enabled: toEnable, alreadyEnabled };
  }

  isClientRunning(): boolean {
    return this.sharedClient !== null;
  }

  /**
   * Fork an existing session. Returns the new session ID.
   * Uses the SDK's experimental sessions.fork RPC to copy events to a new session.
   * Mirrors the post-creation registration steps that create() does:
   * sessionCache.set, ensureSessionMeta.
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

// Wire the throughput snapshot's deferred-definition figure to the manager that owns
// the exclusion set + size store (injection, so session-throughput needs no import of
// session-manager). One registration; every snapshot() thereafter is enriched.
setDeferredDefsProvider(sessionId => sessionManager.deferredDefsSavings(sessionId));

// Central idle-suppression wiring (spec-idle-suppression-central): dispatchState
// suppresses its 'idle' emit while a session is about to auto-continue, so EVERY
// dispatch-emit consumer (waitForActive, waitForIdle, restart-manager) is protected
// by this single predicate — no per-caller opt-in. Injected — dispatch-state imports
// no SessionManager.
dispatchState.setIdleSuppressor(sessionId => sessionManager.hasPendingAutoContinue(sessionId));

// Defer a graceful restart while any reveal-continuation is pending: restart-manager's
// immediate check bypasses the idle emit, so it needs its own gate on the same
// predicate (spec-idle-suppression-central).
setAnyPendingProvider(() => sessionManager.hasAnyPendingAutoContinue());

// The operator's auto-continue preference, injected so SessionManager (which owns
// the pending/attempt state read by hasPendingAutoContinue) needs no import of the
// preferences/session-state modules (spec-idle-authority). Wired once at startup.
let autoContinuePrefProvider: (() => boolean) | null = null;
export function setAutoContinuePrefProvider(fn: () => boolean): void {
  autoContinuePrefProvider = fn;
}
