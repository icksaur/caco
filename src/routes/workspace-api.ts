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
 * Pure: assemble the /servers response payload. Prepends a synthetic `Built-in`
 * server (Caco's own tools, always observed-complete from tools.list), then each
 * MCP server whose available tools (name+description) are enriched with OBSERVED
 * schema (from getCurrentMetadata) when loaded — else marked `observed:false` with
 * `tokenCost:null` (schema genuinely unknown until a request loads the tool).
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
  // client tools.list returns builtins with full schema regardless of exclusion, so
  // mark each deferred-if-excluded here; only add bare entries for excluded builtins
  // tools.list didn't return (e.g. powershell/local_shell on a non-Windows host).
  const deferredSet = new Set(deferredBuiltins.map(n => n.toLowerCase()));
  const listedNames = new Set(builtinTools.map(t => t.name.toLowerCase()));
  const builtin = {
    name: 'Built-in',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: [
      ...builtinTools.map((t): PayloadTool => {
        const deferred = deferredSet.has(t.name.toLowerCase());
        return {
          name: t.name,
          description: t.description,
          namespacedName: t.name,
          observed: !deferred,
          parameters: t.parameters ?? null,
          instructions: t.instructions ?? null,
          deferLoading: false,
          // Even for a deferred builtin we keep the (would-be) token cost — the
          // schema is known; the state badge conveys it's not currently sent.
          tokenCost: estimateToolTokens(t),
          state: deferred ? 'deferred' : 'enabled',
        };
      }),
      // Excluded builtins tools.list did NOT return (no schema available here):
      // bare deferred entries, deduped against the listed ones above.
      ...deferredBuiltins
        .filter(n => !listedNames.has(n.toLowerCase()))
        .map((name): PayloadTool => ({
          name, description: '', namespacedName: name, observed: false,
          parameters: null, instructions: null, deferLoading: false, tokenCost: null,
          state: 'deferred',
        })),
    ],
  };
  // Caco's own defineTool tools. hardDisabled = DEFAULT_DISABLED_TOOLS, filtered
  // before session creation → 'off' (not live-revealable). Others are 'enabled'.
  const caco = {
    name: 'Caco',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: cacoCatalog.map((t): PayloadTool => ({
      name: t.name,
      description: t.description,
      namespacedName: t.name,
      observed: !t.hardDisabled,
      parameters: t.parameters ?? null,
      instructions: null,
      deferLoading: false,
      tokenCost: t.parameters ? estimateToolTokens({ name: t.name, description: t.description, parameters: t.parameters }) : null,
      state: t.hardDisabled ? 'off' : 'enabled',
    })),
  };
  const mcp = servers.map(s => ({
    name: s.name,
    status: s.status,
    source: s.source ?? null,
    error: s.error ?? null,
    tools: (availableByServer[s.name] ?? []).map((t): PayloadTool => {
      const nsName = `${s.name}/${t.name}`;
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
        // Phase A: MCP tools are not yet excluded, so an available tool is enabled.
        // Phase B will mark deferred those in the session exclusion set.
        state: 'enabled',
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
    const mcpServers = await sessionManager.listMcpServers();
    // Available tools (name+description) per MCP server; built-in tools (full
    // schema) from tools.list; observed schema from the resolved per-turn snapshot.
    const [entries, builtinTools, observed] = await Promise.all([
      Promise.all(mcpServers.map(async s => [s.name, await sessionManager.listMcpTools(s.name)] as const)),
      sessionManager.listBuiltinTools(),
      sessionManager.getCurrentToolMetadata(),
    ]);
    const availableByServer = Object.fromEntries(entries);
    // Index observed metadata under every alias it might be matched by, so a
    // difference between the model-facing name (getCurrentMetadata) and the raw
    // MCP name (mcp.listTools) doesn't leave a loaded tool showing "unobserved".
    // Keys tried by the payload builder: `${server}/${toolName}`.
    const observedByKey: Record<string, ObservedMeta> = {};
    for (const m of observed) {
      const meta: ObservedMeta = { name: m.name, description: m.description, parameters: m.input_schema, deferLoading: m.deferLoading };
      const aliases = new Set<string>();
      if (m.mcpServerName && m.mcpToolName) aliases.add(`${m.mcpServerName}/${m.mcpToolName}`);
      if (m.mcpServerName) aliases.add(`${m.mcpServerName}/${m.name}`);
      if (m.namespacedName) aliases.add(m.namespacedName);
      if (aliases.size === 0) aliases.add(m.name);
      for (const k of aliases) observedByKey[k] = meta;
    }
    const servers = buildMcpServerPayload(
      mcpServers, availableByServer, observedByKey, builtinTools,
      // Deferred SDK builtins carry a `builtin:` prefix in the exclusion list; strip
      // it for display (the model-facing name is e.g. `bash`, not `builtin:bash`).
      excludedBuiltinNames().map(n => n.replace(/^builtin:/, '')),
      sessionManager.getCacoToolCatalog(),
    );
    res.json({ configPath, configExists, clientRunning: true, servers });
  } catch (e) {
    console.error('[MCP] Failed to list servers/tools:', e instanceof Error ? e.message : e);
    res.json({ configPath, configExists, clientRunning: true, servers: [], error: 'Failed to query SDK' });
  }
});

export { router };
