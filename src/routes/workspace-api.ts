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
}

/**
 * Recursively sum the character count of all VALUES (not keys) in a tool's
 * model-facing definition, ÷ 4 — an estimate of the per-turn token cost.
 * Pure; the unit-test oracle for the "≈N tokens" display.
 */
export function estimateToolTokens(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | null;
  instructions?: string | null;
}): number {
  let chars = 0;
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') { chars += v.length; return; }
    if (typeof v === 'number' || typeof v === 'boolean') { chars += String(v).length; return; }
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (typeof v === 'object') { for (const val of Object.values(v)) walk(val); return; }
  };
  chars += tool.name.length;
  if (tool.description) chars += tool.description.length;
  if (tool.instructions) chars += tool.instructions.length;
  if (tool.parameters) walk(tool.parameters);
  return Math.round(chars / 4);
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
): Array<{ name: string; status: string; source: string | null; error: string | null; tools: PayloadTool[] }> {
  const builtin = {
    name: 'Built-in',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: builtinTools.map((t): PayloadTool => ({
      name: t.name,
      description: t.description,
      namespacedName: t.name,
      observed: true,
      parameters: t.parameters ?? null,
      instructions: t.instructions ?? null,
      deferLoading: false,
      tokenCost: estimateToolTokens(t),
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
      const observed = !!(obs && obs.parameters);
      return {
        name: t.name,
        description: t.description,
        namespacedName: nsName,
        observed,
        parameters: observed ? (obs!.parameters ?? null) : null,
        instructions: null,
        deferLoading: obs?.deferLoading ?? false,
        tokenCost: observed ? estimateToolTokens({ name: t.name, description: t.description, parameters: obs!.parameters }) : null,
      };
    }),
  }));
  return [builtin, ...mcp];
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
    const observedByKey: Record<string, ObservedMeta> = {};
    for (const m of observed) {
      const key = (m.mcpServerName && m.mcpToolName) ? `${m.mcpServerName}/${m.mcpToolName}` : (m.namespacedName ?? m.name);
      observedByKey[key] = { parameters: m.input_schema, deferLoading: m.deferLoading };
    }
    const servers = buildMcpServerPayload(mcpServers, availableByServer, observedByKey, builtinTools);
    res.json({ configPath, configExists, clientRunning: true, servers });
  } catch (e) {
    console.error('[MCP] Failed to list servers/tools:', e instanceof Error ? e.message : e);
    res.json({ configPath, configExists, clientRunning: true, servers: [], error: 'Failed to query SDK' });
  }
});

export { router };
