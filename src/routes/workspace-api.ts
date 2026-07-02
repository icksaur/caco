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

/**
 * Pure: assemble the /servers response payload. Prepends a synthetic `Built-in`
 * server (Caco's own tools) so there is one tools list, then each MCP server with
 * its tools. Kept pure so the shape (built-in entry, null-normalized fields,
 * empty-tools default) is unit-testable without the SDK.
 */
export function buildMcpServerPayload(
  servers: McpServerStatus[],
  toolsByName: Record<string, { name: string; description: string }[]>,
  builtinTools: { name: string; description: string }[] = [],
): Array<{ name: string; status: string; source: string | null; error: string | null; tools: { name: string; description: string }[] }> {
  const builtin = {
    name: 'Built-in',
    status: 'connected',
    source: 'caco' as string | null,
    error: null as string | null,
    tools: builtinTools,
  };
  const mcp = servers.map(s => ({
    name: s.name,
    status: s.status,
    source: s.source ?? null,
    error: s.error ?? null,
    tools: toolsByName[s.name] ?? [],
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
    // MCP tools: session-scoped mcp.listTools per server. Built-in tools: client
    // tools.list (its only sanctioned use). Same payload, one endpoint.
    const [entries, builtinTools] = await Promise.all([
      Promise.all(mcpServers.map(async s => [s.name, await sessionManager.listMcpTools(s.name)] as const)),
      sessionManager.listBuiltinTools(),
    ]);
    const toolsByName = Object.fromEntries(entries);
    const servers = buildMcpServerPayload(mcpServers, toolsByName, builtinTools);
    res.json({ configPath, configExists, clientRunning: true, servers });
  } catch (e) {
    console.error('[MCP] Failed to list servers/tools:', e instanceof Error ? e.message : e);
    res.json({ configPath, configExists, clientRunning: true, servers: [], error: 'Failed to query SDK' });
  }
});

export { router };
