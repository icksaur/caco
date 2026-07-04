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
import { homedir } from 'os';
import { validatePathMultiple } from '../path-utils.js';
import { sessionManager } from '../session-manager.js';
import { excludedBuiltinNames } from '../tool-registry.js';
import { builtinKey, type ToolKey } from '../tool-key.js';
import { lookupMcpKey, learnFromMetadata } from '../tool-key-registry.js';
import { buildToolCatalog } from '../tool-catalog.js';
import { classifyTool } from '../session-tool-state.js';
import { snapshot as throughputSnapshot } from '../session-throughput.js';
import { getSessionUsage } from '../session-usage-cache.js';

const router = Router();

// Allowed base directories for file operations
const ALLOWED_BASES = [
  process.cwd(),           // Current workspace
  join(homedir(), '.caco'), // Caco directory
  '/tmp'                    // Temp directory
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
  /** Pre-resolved model-facing ToolKey (from the tool-key-registry). */
  key: ToolKey;
  name: string;
  description: string;
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
  /** enablement axis: enabled (model sees it) / deferred (excludedTools, revealable)
   *  / off (DEFAULT_DISABLED, filtered pre-registration, not revealable). */
  state: 'enabled' | 'deferred' | 'off';
}
export interface CacoCatalogTool {
  name: string;
  description: string;
  hardDisabled: boolean;
  parameters?: Record<string, unknown>;
}

/**
 * Estimate a tool's per-turn token cost. The model receives each tool as a
 * SERIALIZED JSON definition, so we count the full JSON length — keys AND values
 * (schema keys like `type`/`properties`/`enum` and every parameter name are real
 * tokens, and dominate for schema-heavy tools) — ÷ BYTES_PER_TOKEN. The char count
 * is exact for the transmitted JSON; only the ÷4 chars-per-token ratio is an
 * approximation (no tokenizer). Pure; the unit-test oracle for the "≈N tokens" display.
 */
export function estimateToolTokens(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | null;
  instructions?: string | null;
}): number {
  const def: Record<string, unknown> = { name: tool.name };
  if (tool.description) def.description = tool.description;
  if (tool.parameters) def.parameters = tool.parameters;
  if (tool.instructions) def.instructions = tool.instructions;
  return Math.round(JSON.stringify(def).length / 4);
}

/**
 * Pure: assemble the /servers response payload. Consumes the unified
 * `buildToolCatalog` (the single "what tools exist" view) for the Built-in and
 * Caco groups, and `classifyTool` for every tool's enabled/deferred/off state, so
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
): Array<{ name: string; status: string; source: string | null; error: string | null; tools: PayloadTool[] }> {
  // The exclusion set as canonical ToolKeys (what classifyTool compares against).
  const excluded = new Set<ToolKey>(deferredBuiltins.map(n => builtinKey(n)));
  // Builtins present in tools.list carry a real schema → a real tokenCost; a builtin
  // known only by an excluded name (e.g. powershell on a non-Windows host) has no
  // schema → tokenCost stays null (never fabricated).
  const listedBuiltinKeys = new Set<ToolKey>(builtinTools.map(t => builtinKey(t.name)));
  const bareDeferred = deferredBuiltins
    .filter(n => !listedBuiltinKeys.has(builtinKey(n)))
    .map(n => ({ name: n, description: '' }));

  const catalog = buildToolCatalog({
    caco: cacoCatalog.map(c => ({ name: c.name, description: c.description, hardDisabled: c.hardDisabled, parameters: c.parameters })),
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
      const state = classifyTool(t.key, { excluded, hardDisabled: false });
      const listed = listedBuiltinKeys.has(t.key);
      return {
        name: t.name,
        description: t.description,
        namespacedName: t.name,
        observed: state !== 'deferred',
        parameters: t.parameters ?? null,
        instructions: t.instructions ?? null,
        deferLoading: false,
        // Keep the (would-be) token cost for a deferred-but-listed builtin — the
        // schema is known; the state badge conveys it's not currently sent. A bare
        // (unlisted) builtin has no schema, so cost is genuinely unknown → null.
        tokenCost: listed
          ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters ?? null, instructions: t.instructions ?? null })
          : null,
        state,
      };
    }),
  };
  const caco = {
    name: 'Caco',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: entries.filter(t => t.origin === 'caco').map((t): PayloadTool => {
      const state = classifyTool(t.key, { excluded, hardDisabled: t.hardDisabled });
      return {
        name: t.name,
        description: t.description,
        namespacedName: t.name,
        observed: !t.hardDisabled,
        parameters: t.parameters ?? null,
        instructions: null,
        deferLoading: false,
        tokenCost: t.parameters ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters }) : null,
        state,
      };
    }),
  };
  const mcp = servers.map(s => ({
    name: s.name,
    status: s.status,
    source: s.source ?? null,
    error: s.error ?? null,
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
        // classifyTool over the shared exclusion set: Phase A has no excluded MCP
        // tools, so these are enabled; Phase B marks session-excluded ones deferred.
        state: classifyTool(key, { excluded, hardDisabled: false }),
      };
    }),
  }));
  return [builtin, caco, ...mcp];
}

router.get('/servers', async (_req: Request, res: Response) => {
  const configPath = join(homedir(), '.copilot', 'mcp-config.json');
  const configExists = existsSync(configPath);
  const clientRunning = sessionManager.isClientRunning();

  if (!clientRunning) {
    res.json({ configPath, configExists, clientRunning: false, servers: [] });
    return;
  }

  try {
    // Thread ONE consistent target session (most-recent) through the MCP listing,
    // observed metadata (key learning), and context-info calls, so a tool loaded in
    // that session isn't omitted because a different session's metadata was inspected.
    const target = sessionManager.mostRecentActiveSessionId() ?? undefined;
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
    // raw MCP tool to its discovered key (omit — never fabricate — any not yet learned).
    learnFromMetadata(observed);
    const availableByServer: Record<string, AvailableTool[]> = {};
    for (const [server, tools] of Object.entries(rawByServer)) {
      availableByServer[server] = tools
        .map(t => { const key = lookupMcpKey(server, t.name); return key ? { key, name: t.name, description: t.description } : null; })
        .filter((t): t is AvailableTool => t !== null);
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
    );
    // Telemetry (spec-tool-reveal B0): the SDK's ground-truth token breakdown +
    // that same session's last-turn cache split (the reveal cache-bust signal). Both
    // scoped to the first active session (like getCurrentToolMetadata above); null
    // when uninitialized. `toolDefinitionsTokens`/`mcpToolsTokens` EXCLUDE deferred
    // tools — so this number drops when deferral lands, the whole feature's payoff.
    // The real model window comes from usage_info (contextInfo echoes the 0 we pass
    // as its default 128k, which is NOT the true limit).
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

export { router };
