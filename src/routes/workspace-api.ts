/**
 * MCP Wrapper for Applets
 * 
 * Exposes MCP tool functionality to applets via HTTP API.
 * Currently provides file system operations.
 */

import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { validatePathMultiple } from '../path-utils.js';
import { sessionManager } from '../session-manager.js';
import { excludedBuiltinNames, isDeferEligibleCacoEntry, isPseudoServer } from '../tool-registry.js';
import { builtinKey, type ToolKey } from '../tool-key.js';
import { lookupMcpKey, learnFromMetadata } from '../tool-key-registry.js';
import { buildToolCatalog } from '../tool-catalog.js';
import { classifyTool } from '../session-tool-state.js';
import { getDeferredServers } from '../manual-defer-store.js';
import { getAutoDeferred } from '../auto-defer-store.js';
import { getNowActiveSeconds, getLastUsedActiveSeconds, DEFER_STALE_THRESHOLD_ACTIVE_SECONDS } from '../tool-usage-store.js';
import { estimateToolTokens } from '../tool-size.js';
import { getToolSize, recordObservedSizes } from '../tool-size-store.js';
import { snapshot as throughputSnapshot } from '../session-throughput.js';
import { getSessionUsage } from '../session-usage-cache.js';

const router = Router();

// Allowed base directories for file operations
const ALLOWED_BASES = [
  process.cwd(),           // Current workspace
  join(homedir(), '.caco'), // Caco directory
  '/tmp',                   // Temp directory (Linux)
  tmpdir()                  // OS temp directory (cross-platform)
];

/**
 * POST /api/mcp/read_file
 * Read file contents
 */
router.post('/read_file', async (req: Request, res: Response) => {
  try {
    const { path } = req.body as { path?: string };
    
    if (!path) {
      res.status(400).json({ ok: false, error: 'path required' });
      return;
    }
    
    const validation = validatePathMultiple(ALLOWED_BASES, path);
    if (!validation.valid) {
      res.status(403).json({ ok: false, error: validation.error });
      return;
    }
    
    const content = await readFile(validation.resolved, 'utf-8');
    res.json({ ok: true, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

/**
 * POST /api/mcp/write_file
 * Write file contents
 */
router.post('/write_file', async (req: Request, res: Response) => {
  try {
    const { path, content } = req.body as { path?: string; content?: string };
    
    if (!path || content === undefined) {
      res.status(400).json({ ok: false, error: 'path and content required' });
      return;
    }
    
    const validation = validatePathMultiple(ALLOWED_BASES, path);
    if (!validation.valid) {
      res.status(403).json({ ok: false, error: validation.error });
      return;
    }
    
    await writeFile(validation.resolved, content, 'utf-8');
    res.json({ ok: true, path: validation.resolved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

/**
 * POST /api/mcp/list_directory
 * List directory contents
 */
router.post('/list_directory', async (req: Request, res: Response) => {
  try {
    const { path } = req.body as { path?: string };
    
    if (!path) {
      res.status(400).json({ ok: false, error: 'path required' });
      return;
    }
    
    const validation = validatePathMultiple(ALLOWED_BASES, path);
    if (!validation.valid) {
      res.status(403).json({ ok: false, error: validation.error });
      return;
    }
    
    const entries = await readdir(validation.resolved);
    const files = await Promise.all(
      entries.map(async (name) => {
        const fullPath = join(validation.resolved, name);
        const stats = await stat(fullPath);
        return {
          name,
          path: fullPath,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modified: stats.mtime.toISOString()
        };
      })
    );
    
    res.json({ ok: true, files });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ ok: false, error: message });
  }
});

/**
 * GET /api/mcp/tools
 * List available MCP tools
 */
router.get('/tools', (_req: Request, res: Response) => {
  res.json({
    tools: [
      {
        name: 'read_file',
        description: 'Read file contents',
        parameters: {
          path: 'string - File path to read'
        }
      },
      {
        name: 'write_file',
        description: 'Write file contents',
        parameters: {
          path: 'string - File path to write',
          content: 'string - Content to write'
        }
      },
      {
        name: 'list_directory',
        description: 'List directory contents',
        parameters: {
          path: 'string - Directory path to list'
        }
      }
    ],
    allowedDirectories: ALLOWED_BASES
  });
});

interface McpServerStatus {
  name: string;
  status: string;
  source?: string;
  error?: string;
}

interface AvailableTool {
  /** Exclusion key when learned, else a display-only `server/tool` id (excludable:false). */
  key: ToolKey;
  name: string;
  description: string;
  /** Whether `key` is the real exclusion string (learned) vs a display placeholder. */
  excludable: boolean;
}
interface BuiltinTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  instructions?: string;
}
/** Observed metadata keyed by `${serverName}/${toolName}` (MCP) or tool name (built-in). */
interface ObservedMeta {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  deferLoading?: boolean;
}
interface PayloadTool {
  name: string;
  description: string;
  namespacedName: string;
  observed: boolean;
  parameters: Record<string, unknown> | null;
  instructions: string | null;
  deferLoading: boolean;
  tokenCost: number | null;
  /** Best-known per-turn definition size, independent of current observation: for a
   *  DEFERRED tool (no live schema) this is its last-observed size (MCP, from the size
   *  store) or its local estimate (Caco-allowlist), so the applet can show
   *  "deferred · ~N tokens". null when never observed / not knowable. */
  knownTokenCost: number | null;
  /** presentation axis: enabled (model sees it) / deferred (dynamically excluded this
   *  session, re-enableable) / disabled (policy: hard-disabled or policy-excluded builtin,
   *  no cost, NOT re-enableable). */
  state: 'enabled' | 'deferred' | 'disabled';
  /** Active-clock seconds since this tool was last used, or null if never used
   *  (system-wide; Phase C1 usage store). null renders as "never". */
  ageActiveSeconds: number | null;
  /** Whether cold-resume auto-defer MAY hide this tool (MCP / excludable builtin /
   *  Caco allowlist). Non-eligible tools are always kept. */
  deferEligible: boolean;
  /** Unused longer than the stale threshold (never-used = maximally stale). */
  stale: boolean;
  /** The cold-resume verdict: eligible AND stale ⇒ would auto-defer at the next
   *  cold resume (per-session used-here protection is applied at resume, not here). */
  wouldDefer: boolean;
}
export interface CacoCatalogTool {
  name: string;
  description: string;
  hardDisabled: boolean;
  /** Built-in vs extension. Carried so the eligibility verdict below is computed
   *  from the same predicate enumeration uses; `CatalogTool` collapses every Caco
   *  source to origin 'caco', so it cannot be recovered downstream. */
  origin: 'builtin' | 'extension';
  parameters?: Record<string, unknown>;
}

// estimateToolTokens now lives in the leaf module `tool-size.ts` (shared with the
// observed-size capture path); imported above and re-exported for existing importers.
export { estimateToolTokens };

/** Pure: resolve the `/servers` target session. Honors an explicit requested id when
 *  it names an ACTIVE session (a cold/unknown session has no in-memory exclusion set
 *  to read); otherwise falls back to the most-recent-active session. Keeps the
 *  viewed-session-vs-fallback decision unit-testable without the SDK. */
export function resolveServersTarget(
  requested: string | undefined,
  isActive: (id: string) => boolean,
  mostRecentActive: string | null,
): string | undefined {
  if (requested && isActive(requested)) return requested;
  return mostRecentActive ?? undefined;
}

/**
 * Pure: assemble the /servers response payload. Consumes the unified
 * `buildToolCatalog` (the single "what tools exist" view) for the Built-in and
 * Caco groups, and `classifyTool` for every tool's enabled/deferred/disabled state, so
 * the three-axis truth and the tool universe are defined once (spec-tool-reveal:
 * "one catalog assembly" + "one classifier"). MCP tools are grouped per server and
 * enriched with OBSERVED schema (from getCurrentMetadata) when loaded — else
 * `observed:false`/`tokenCost:null` (schema unknown until a request loads it).
 * Kept pure so the merge + token math are unit-testable without the SDK.
 */
export function buildMcpServerPayload(
  servers: McpServerStatus[],
  availableByServer: Record<string, AvailableTool[]>,
  observedByKey: Record<string, ObservedMeta>,
  builtinTools: BuiltinTool[] = [],
  deferredBuiltins: string[] = [],
  cacoCatalog: CacoCatalogTool[] = [],
  deferredServers: string[] = [],
  usage?: { nowActiveSeconds: number; lastUsed: ReadonlyMap<ToolKey, number> },
  sessionExcludedKeys: ToolKey[] = [],
  autoDeferredKeys: ReadonlySet<ToolKey> = new Set(),
): Array<{ name: string; status: string; source: string | null; error: string | null; deferred?: boolean; tools: PayloadTool[] }> {
  const deferredServerSet = new Set(deferredServers);
  // The exclusion set as canonical ToolKeys (what classifyTool compares against): the
  // process-default deferred builtins PLUS the target session's LIVE exclusion set (its
  // auto/manual-deferred MCP + Caco keys). Without the live set, MCP/Caco tools would
  // always classify `enabled` (the builtin-only set never contains their keys), so an
  // actually-deferred tool would mis-render as enabled/unobserved. classifyTool over the
  // real live set is what lets the applet show a true "deferred" state, not a prediction.
  const excluded = new Set<ToolKey>([...deferredBuiltins.map(n => builtinKey(n)), ...sessionExcludedKeys]);
  // Policy-disabled = the builtin exclusions (shell family + platform-absent builtins):
  // permanent app-layer policy, shown 'disabled' (not 'deferred') and not re-enableable.
  // MCP tools are never policy-disabled (C2 never defers builtins), so an excluded MCP/
  // Caco-allowlist tool classifies 'deferred' while an excluded builtin classifies 'disabled'.
  const policyDisabled = new Set<ToolKey>(deferredBuiltins.map(n => builtinKey(n)));

  // Per-tool usage/age + defer verdict, from the shared threshold so the applet view
  // can't disagree with what auto-defer would actually do. `eligible` is the origin-
  // based defer candidacy the caller determines. `wouldDefer` is LATCH-AWARE
  // (spec-auto-defer-latch): a tool already in the persisted auto-defer latch is seeded
  // deferred at the next seam regardless of current freshness, so the badge must show it
  // even when live staleness is false. `stale` stays the raw live staleness signal.
  function usageFields(key: ToolKey, eligible: boolean): Pick<PayloadTool, 'ageActiveSeconds' | 'deferEligible' | 'stale' | 'wouldDefer'> {
    const latched = autoDeferredKeys.has(key);
    if (!usage) return { ageActiveSeconds: null, deferEligible: eligible, stale: false, wouldDefer: latched };
    const everUsed = usage.lastUsed.has(key);
    const ageActiveSeconds = everUsed ? Math.max(0, usage.nowActiveSeconds - (usage.lastUsed.get(key) as number)) : null;
    const stale = !everUsed || (ageActiveSeconds as number) > DEFER_STALE_THRESHOLD_ACTIVE_SECONDS;
    return { ageActiveSeconds, deferEligible: eligible, stale, wouldDefer: latched || (eligible && stale) };
  }
  // Builtins present in tools.list carry a real schema → a real tokenCost; a builtin
  // known only by an excluded name (e.g. powershell on a non-Windows host) has no
  // schema → tokenCost stays null (never fabricated).
  const listedBuiltinKeys = new Set<ToolKey>(builtinTools.map(t => builtinKey(t.name)));
  const bareDeferred = deferredBuiltins
    .filter(n => !listedBuiltinKeys.has(builtinKey(n)))
    .map(n => ({ name: n, description: '' }));

  const catalog = buildToolCatalog({
    caco: cacoCatalog.map(c => ({
      name: c.name, description: c.description, hardDisabled: c.hardDisabled, parameters: c.parameters,
      deferEligible: isDeferEligibleCacoEntry(c),
    })),
    builtins: [...builtinTools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, instructions: t.instructions })), ...bareDeferred],
    mcp: servers.map(s => ({ serverName: s.name, tools: availableByServer[s.name] ?? [] })),
  });
  const entries = [...catalog.values()];

  const builtin = {
    name: 'Built-in',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: entries.filter(t => t.origin === 'builtin').map((t): PayloadTool => {
      const state = classifyTool(t.key, { excluded, hardDisabled: false, policyDisabled });
      const listed = listedBuiltinKeys.has(t.key);
      return {
        name: t.name,
        description: t.description,
        namespacedName: t.name,
        // Only an ENABLED tool is actually in the turn's resolved set; deferred and
        // policy-disabled builtins are not sent to the model.
        observed: state === 'enabled',
        parameters: t.parameters ?? null,
        instructions: t.instructions ?? null,
        deferLoading: false,
        // Keep the (would-be) token cost for a deferred-but-listed builtin — the
        // schema is known; the state badge conveys it's not currently sent. A bare
        // (unlisted) builtin has no schema, so cost is genuinely unknown → null.
        tokenCost: listed
          ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters ?? null, instructions: t.instructions ?? null })
          : null,
        // Builtins are never dynamically deferred (policy only), so known == live cost.
        knownTokenCost: listed
          ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters ?? null, instructions: t.instructions ?? null })
          : null,
        state,
        ...usageFields(t.key, excluded.has(t.key)),
      };
    }),
  };
  const caco = {
    name: 'Caco',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: entries.filter(t => t.origin === 'caco').map((t): PayloadTool => {
      const state = classifyTool(t.key, { excluded, hardDisabled: t.hardDisabled, policyDisabled });
      // Caco schemas are locally available, so a deferred Caco-allowlist tool still
      // prices directly from its params — no observed-size cache needed.
      const cacoCost = t.parameters ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters }) : null;
      return {
        name: t.name,
        description: t.description,
        namespacedName: t.name,
        // Only an ENABLED Caco tool is in the turn's set; deferred (auto-deferred
        // allowlist) and disabled (hard-disabled) ones are not sent.
        observed: state === 'enabled',
        parameters: t.parameters ?? null,
        instructions: null,
        deferLoading: false,
        tokenCost: cacoCost,
        knownTokenCost: cacoCost,
        state,
        ...usageFields(t.key, t.deferEligible === true),
      };
    }),
  };
  const mcp = servers.map(s => {
    const serverKeys = (availableByServer[s.name] ?? []).map(t => t.key);
    // System-wide deferred verdict the applet button reflects: operator manual defer OR
    // ANY of the server's keys latched (spec-auto-defer-latch). ANY (not "fully") so a
    // partially-latched server still exposes the operator's only CLEAR path; the non-
    // empty guard avoids the vacuous-truth trap (an unkeyable server isn't "deferred").
    const hasAutoLatched = serverKeys.length > 0 && serverKeys.some(k => autoDeferredKeys.has(k));
    return {
    name: s.name,
    status: s.status,
    source: s.source ?? null,
    error: s.error ?? null,
    deferred: deferredServerSet.has(s.name) || hasAutoLatched,
    tools: (availableByServer[s.name] ?? []).map((t): PayloadTool => {
      const key = t.key;
      const nsName = key as string;
      const obs = observedByKey[nsName];
      // Presence in the observed set = observed (the tool resolved into the turn).
      // Its schema is independently optional: an observed tool may carry no
      // input_schema, in which case parameters/tokenCost are null but it is still
      // observed (NOT deferred). tokenCost is null only when we have no schema to
      // measure — never fabricated.
      const observed = !!obs;
      const params = obs?.parameters ?? null;
      // Prefer the observed model-facing name/description (what the model actually
      // sees) over the raw mcp.listTools values when present — accurate seam.
      const estName = obs?.name ?? t.name;
      const estDesc = obs?.description ?? t.description;
      return {
        name: t.name,
        description: t.description,
        namespacedName: nsName,
        observed,
        parameters: params,
        instructions: null,
        deferLoading: obs?.deferLoading ?? false,
        tokenCost: params ? estimateToolTokens({ name: estName, description: estDesc, parameters: params }) : null,
        // Known size independent of current observation: the live estimate when the
        // schema is present, else the last-observed size from the persisted store — so
        // a DEFERRED MCP tool (no live schema) still shows "deferred · ~N tokens".
        knownTokenCost: params
          ? estimateToolTokens({ name: estName, description: estDesc, parameters: params })
          : getToolSize(key) ?? null,
        // classifyTool over the shared exclusion set: Phase A has no excluded MCP
        // tools, so these are enabled; Phase B marks session-excluded ones deferred.
        state: classifyTool(key, { excluded, hardDisabled: false, policyDisabled }),
        // MCP tools are defer-eligible only once their exclusion key is learned
        // (excludable) — we can't defer what we can't key.
        ...usageFields(key, t.excludable),
      };
    }),
    };
  });
  return [builtin, caco, ...mcp];
}

router.get('/servers', async (req: Request, res: Response) => {
  const configPath = join(homedir(), '.copilot', 'mcp-config.json');
  const configExists = existsSync(configPath);
  const clientRunning = sessionManager.isClientRunning();

  if (!clientRunning) {
    res.json({ configPath, configExists, clientRunning: false, servers: [] });
    return;
  }

  try {
    // Thread ONE consistent target session through the MCP listing, observed metadata
    // (key learning), and exclusion set, so the applet reflects the session the operator
    // is VIEWING. Honor an explicit ?sessionId when it names an active session (a cold/
    // unknown one has no in-memory exclusion set); else fall back to most-recent-active.
    const requested = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const target = resolveServersTarget(
      requested,
      id => sessionManager.isActive(id),
      sessionManager.mostRecentActiveSessionId(),
    );
    const mcpServers = await sessionManager.listMcpServers(target);
    // Available tools (name+description) per MCP server; built-in tools (full
    // schema) from tools.list; observed schema from the resolved per-turn snapshot;
    // ground-truth context-window token breakdown (SDK's own accounting).
    const [entries, builtinTools, observed, ctx] = await Promise.all([
      Promise.all(mcpServers.map(async s => [s.name, await sessionManager.listMcpTools(s.name, target)] as const)),
      sessionManager.listBuiltinTools(),
      sessionManager.getCurrentToolMetadata(target),
      sessionManager.getContextInfo(),
    ]);
    const rawByServer = Object.fromEntries(entries);
    // Learn model-facing MCP keys from the resolved metadata, then resolve each listed
    // raw MCP tool to its discovered key. If not yet learned, keep a display-only
    // `server/tool` id (excludable:false) so the tool is still SHOWN — never dropped.
    learnFromMetadata(observed);
    recordObservedSizes(observed);
    const availableByServer: Record<string, AvailableTool[]> = {};
    for (const [server, tools] of Object.entries(rawByServer)) {
      availableByServer[server] = tools.map(t => {
        const learned = lookupMcpKey(server, t.name);
        return learned
          ? { key: learned, name: t.name, description: t.description, excludable: true }
          : { key: `${server}/${t.name}` as ToolKey, name: t.name, description: t.description, excludable: false };
      });
    }
    // Index observed metadata by the canonical model-facing key (what the payload's MCP
    // branch looks up) plus its raw name as a fallback alias.
    const observedByKey: Record<string, ObservedMeta> = {};
    for (const m of observed) {
      const meta: ObservedMeta = { name: m.name, description: m.description, parameters: m.input_schema, deferLoading: m.deferLoading };
      observedByKey[m.name] = meta; // model-facing name == the MCP ToolKey
      if (m.namespacedName) observedByKey[m.namespacedName] = meta;
    }
    const servers = buildMcpServerPayload(
      mcpServers, availableByServer, observedByKey, builtinTools,
      // Deferred SDK builtins carry a `builtin:` prefix in the exclusion list; strip
      // it for display (the model-facing name is e.g. `bash`, not `builtin:bash`).
      excludedBuiltinNames().map(n => n.replace(/^builtin:/, '')),
      sessionManager.getCacoToolCatalog(),
      getDeferredServers(),
      { nowActiveSeconds: getNowActiveSeconds(), lastUsed: getLastUsedActiveSeconds() },
      // The target session's LIVE exclusion set (auto/manual-deferred MCP + Caco keys),
      // so actually-deferred tools classify as `deferred` rather than mis-rendering as
      // enabled. Empty when no session is active (falls back to builtin defaults only).
      target ? sessionManager.getExcludedToolKeys(target) : [],
      getAutoDeferred(),
    );
    // Telemetry (spec-tool-reveal B0): the SDK's ground-truth token breakdown +
    // that session's last-turn cache split (the reveal cache-bust signal). Scoped to
    // getContextInfo()'s first-active session — deliberately NOT the viewed `target`
    // used for the server list above (getContextInfo takes no target); null when
    // uninitialized. `toolDefinitionsTokens`/`mcpToolsTokens` EXCLUDE deferred tools —
    // so this number drops when deferral lands, the whole feature's payoff. The real
    // model window comes from usage_info (contextInfo echoes the 0 we pass as its
    // default 128k, which is NOT the true limit).
    const tp = ctx.sessionId ? throughputSnapshot(ctx.sessionId) : null;
    const usage = ctx.sessionId ? getSessionUsage(ctx.sessionId) : undefined;
    const telemetry = ctx.contextInfo ? {
      toolDefinitionsTokens: ctx.contextInfo.toolDefinitionsTokens,
      mcpToolsTokens: ctx.contextInfo.mcpToolsTokens,
      systemTokens: ctx.contextInfo.systemTokens,
      conversationTokens: ctx.contextInfo.conversationTokens,
      totalTokens: ctx.contextInfo.totalTokens,
      tokenLimit: usage?.tokenLimit ?? 0,
      lastCacheWriteTokens: tp ? tp.lastCacheWriteTokens : 0,
      lastCacheReadTokens: tp ? tp.lastCacheReadTokens : 0,
    } : null;
    res.json({ configPath, configExists, clientRunning: true, servers, telemetry });
  } catch (e) {
    console.error('[MCP] Failed to list servers/tools:', e instanceof Error ? e.message : e);
    res.json({ configPath, configExists, clientRunning: true, servers: [], error: 'Failed to query SDK' });
  }
});

/**
 * POST /api/mcp/servers/:server/defer  { deferred: boolean }
 * Manually defer/undefer a whole MCP server (spec-tool-reveal Phase D). Persists the
 * system-wide preference and applies it live to every active session (each warm session
 * pays a one-time cache-bust — the applet warns). Returns how many sessions changed.
 */
router.post('/servers/:server/defer', async (req: Request, res: Response) => {
  const server = String(req.params.server);
  const { deferred } = req.body as { deferred?: boolean };
  if (typeof deferred !== 'boolean') {
    res.status(400).json({ ok: false, error: 'deferred (boolean) required' });
    return;
  }
  // "Caco"/"Built-in" are synthetic groupings, not MCP servers: they own no learned
  // keys, so this is inert today — but only incidentally. Refuse it rather than let a
  // meaningless name into persisted defer state and a misleading applet badge.
  if (isPseudoServer(server)) {
    res.status(400).json({ ok: false, error: `${server} is not an MCP server; its tools defer by usage, not by operator toggle` });
    return;
  }
  try {
    const result = await sessionManager.setServerDeferred(server, deferred);
    res.json({ ok: true, server, deferred, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export { router };
