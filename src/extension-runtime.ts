/**
 * Extension Runtime
 *
 * Loads server-side extensions via jiti (TypeScript without compile step).
 * Each extension gets a ServerExtensionAPI with access to routing, tools, WS, and storage.
 */

import { type Express, Router } from 'express';
import { createJiti } from 'jiti';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { listExtensions, type ExtensionInfo } from './extension-store.js';
import { broadcastGlobalEvent, broadcastEvent } from './routes/websocket.js';
import type { SessionEvent } from './routes/websocket.js';
import type { WebSocket } from 'ws';

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
}

export interface ServerExtensionAPI {
  router: ReturnType<typeof Router>;
  registerTool(tool: ToolDefinition): void;
  broadcast(type: string, data?: unknown): void;
  broadcastToSession(sessionId: string, type: string, data?: unknown): void;
  onClientMessage(type: string, handler: (ws: WebSocket, data: unknown) => void): void;
  setDescription(description: string): void;
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;
}

interface ExtensionMetadata {
  slug: string;
  description?: string;
  tools: string[];
  hasCSS: boolean;
  hasClient: boolean;
  hasServer: boolean;
}

const clientMessageHandlers = new Map<string, (ws: WebSocket, data: unknown) => void>();
const extensionMetadata = new Map<string, ExtensionMetadata>();

export async function loadServerExtensions(app: Express): Promise<ToolDefinition[]> {
  const extensions = await listExtensions();
  const allTools: ToolDefinition[] = [];

  for (const ext of extensions) {
    const meta: ExtensionMetadata = {
      slug: ext.slug,
      description: ext.description,
      tools: [],
      hasCSS: ext.provides.includes('css'),
      hasClient: ext.provides.includes('client'),
      hasServer: ext.provides.includes('server'),
    };

    if (ext.provides.includes('server')) {
      try {
        const tools = await loadOneServerExtension(app, ext, meta);
        allTools.push(...tools);
      } catch (err) {
        console.error(`[EXT:${ext.slug}] Failed to load server extension:`, err);
      }
    }

    extensionMetadata.set(ext.slug, meta);
  }

  console.log(`✓ ${extensionMetadata.size} extension(s) discovered, ${allTools.length} tool(s) registered`);
  return allTools;
}

async function loadOneServerExtension(
  app: Express,
  ext: ExtensionInfo,
  meta: ExtensionMetadata,
): Promise<ToolDefinition[]> {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import(join(ext.dir, 'server.ts')) as { default?: (api: ServerExtensionAPI) => void };
  if (typeof mod.default !== 'function') {
    console.warn(`[EXT:${ext.slug}] server.ts has no default export`);
    return [];
  }

  const extRouter = Router();
  const tools: ToolDefinition[] = [];

  const api: ServerExtensionAPI = {
    router: extRouter,

    registerTool(tool: ToolDefinition) {
      tools.push(tool);
      meta.tools.push(tool.name);
    },

    broadcast(type: string, data?: unknown) {
      broadcastGlobalEvent({ type, data } as SessionEvent);
    },

    broadcastToSession(sessionId: string, type: string, data?: unknown) {
      broadcastEvent(sessionId, { type, data } as SessionEvent);
    },

    onClientMessage(type: string, handler: (ws: WebSocket, data: unknown) => void) {
      if (clientMessageHandlers.has(type)) {
        console.warn(`[EXT:${ext.slug}] Overwriting existing handler for ${type}`);
      }
      clientMessageHandlers.set(type, handler);
    },

    setDescription(description: string) {
      meta.description = description;
    },

    getState<T>(key: string): T | undefined {
      try {
        const raw = readFileSync(join(ext.dir, 'state.json'), 'utf-8');
        return JSON.parse(raw)[key] as T;
      } catch {
        return undefined;
      }
    },

    setState<T>(key: string, value: T): void {
      const statePath = join(ext.dir, 'state.json');
      let state: Record<string, unknown> = {};
      try {
        state = JSON.parse(readFileSync(statePath, 'utf-8'));
      } catch { /* fresh state */ }
      state[key] = value;
      mkdirSync(ext.dir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    },
  };

  mod.default(api);
  app.use(`/ext/${ext.slug}`, extRouter);
  return tools;
}

export function getClientMessageHandler(type: string): ((ws: WebSocket, data: unknown) => void) | undefined {
  return clientMessageHandlers.get(type);
}

export function getExtensionMetadata(): ExtensionMetadata[] {
  return [...extensionMetadata.values()];
}
