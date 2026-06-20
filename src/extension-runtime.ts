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
import { broadcastGlobalEvent, broadcastEvent } from './event-bus.js';
import type { SessionEvent } from './event-bus.js';
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

/**
 * Owns the mutable extension state (client message handlers + metadata) so the
 * bad states are unrepresentable: stale handlers cannot survive a reload
 * (unload clears them) and two extensions cannot claim the same client message
 * type (duplicate registration throws instead of silently overwriting).
 */
export class ExtensionRuntime {
  private readonly clientMessageHandlers = new Map<string, (ws: WebSocket, data: unknown) => void>();
  private readonly extensionMetadata = new Map<string, ExtensionMetadata>();

  async load(app: Express): Promise<ToolDefinition[]> {
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
          const tools = await this.loadOne(app, ext, meta);
          allTools.push(...tools);
        } catch (err) {
          console.error(`[EXT:${ext.slug}] Failed to load server extension:`, err);
        }
      }

      this.extensionMetadata.set(ext.slug, meta);
    }

    console.log(`✓ ${this.extensionMetadata.size} extension(s) discovered, ${allTools.length} tool(s) registered`);
    return allTools;
  }

  /**
   * Releases stale handler closures and metadata. Does NOT remove the per-slug
   * Express routers mounted in load() — Express has no public un-route, so
   * reload is handler-safe but NOT route-safe (see spec).
   */
  unload(): void {
    this.clientMessageHandlers.clear();
    this.extensionMetadata.clear();
  }

  async reload(app: Express): Promise<ToolDefinition[]> {
    this.unload();
    return this.load(app);
  }

  getClientMessageHandler(type: string): ((ws: WebSocket, data: unknown) => void) | undefined {
    return this.clientMessageHandlers.get(type);
  }

  getMetadata(): ExtensionMetadata[] {
    return [...this.extensionMetadata.values()];
  }

  /**
   * Registers a client message handler. Two extensions claiming the same type
   * is a programming error, not a recoverable warning — so this throws rather
   * than silently overwriting the prior handler.
   */
  registerClientMessageHandler(type: string, handler: (ws: WebSocket, data: unknown) => void, slug: string): void {
    if (this.clientMessageHandlers.has(type)) {
      throw new Error(`[EXT:${slug}] client message type "${type}" is already registered by another extension`);
    }
    this.clientMessageHandlers.set(type, handler);
  }

  private async loadOne(
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

      registerTool: (tool: ToolDefinition) => {
        tools.push(tool);
        meta.tools.push(tool.name);
      },

      broadcast: (type: string, data?: unknown) => {
        broadcastGlobalEvent({ type, data } as SessionEvent);
      },

      broadcastToSession: (sessionId: string, type: string, data?: unknown) => {
        broadcastEvent(sessionId, { type, data } as SessionEvent);
      },

      onClientMessage: (type: string, handler: (ws: WebSocket, data: unknown) => void) => {
        this.registerClientMessageHandler(type, handler, ext.slug);
      },

      setDescription: (description: string) => {
        meta.description = description;
      },

      getState: <T>(key: string): T | undefined => {
        try {
          const raw = readFileSync(join(ext.dir, 'state.json'), 'utf-8');
          return JSON.parse(raw)[key] as T;
        } catch {
          return undefined;
        }
      },

      setState: <T>(key: string, value: T): void => {
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
}

export const extensionRuntime = new ExtensionRuntime();

export function loadServerExtensions(app: Express): Promise<ToolDefinition[]> {
  return extensionRuntime.load(app);
}

export function getClientMessageHandler(type: string): ((ws: WebSocket, data: unknown) => void) | undefined {
  return extensionRuntime.getClientMessageHandler(type);
}

export function getExtensionMetadata(): ExtensionMetadata[] {
  return extensionRuntime.getMetadata();
}
