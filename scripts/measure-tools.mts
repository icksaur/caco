#!/usr/bin/env node
/**
 * Tool-diet byte oracle. Instantiates every caco tool factory and sums the
 * per-turn schema cost (description + JSON-schema of parameters) per group.
 * This is the independent measurement used to gate A4/A5: run before and after
 * each diet change to confirm the byte tax actually dropped.
 *
 * Usage: npx tsx scripts/measure-tools.mts
 */
import { z } from 'zod';
import { createDisplayTools } from '../src/display-tools.js';
import { createAppletTools } from '../src/applet-tools.js';
import { createAgentTools } from '../src/agent-tools.js';
import { createMcpAuthTools } from '../src/mcp-auth-tools.js';
import { createDevDocsTool } from '../src/dev-docs-tool.js';
import { createExtensionsTool } from '../src/extensions-tool.js';
import { createSwarmTool } from '../src/swarm-tool.js';
import { createDelegateTool } from '../src/delegate-tool.js';
import { createSessionHistoryTool } from '../src/session-history-tool.js';
import { createMemoryTools } from '../src/memory-tool.js';
import { createOfferActionTool } from '../src/offer-action-tool.js';
import { createIndexTool } from '../src/index-tool.js';
import { createRetrieveOutputTool } from '../src/observe/retrieve-tool.js';
import { createWorkflowTool } from '../src/workflow/tool.js';
import { createSurfaceTools } from '../src/surface-tools.js';
import { createBrowserTools } from '../src/browser-tools.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ref = { id: 'measure' } as any;
const noop = (() => {}) as any;

const groups: Record<string, any[]> = {
  display: createDisplayTools(noop, noop),
  applet: createAppletTools('/tmp', ref, noop),
  agent: createAgentTools(ref, () => undefined as any),
  'mcp-auth': createMcpAuthTools(),
  'dev-docs': createDevDocsTool('/tmp'),
  extensions: createExtensionsTool(),
  swarm: createSwarmTool(ref),
  delegate: createDelegateTool(ref),
  'session-history': createSessionHistoryTool(),
  memory: createMemoryTools(),
  'offer-action': createOfferActionTool(ref),
  index: createIndexTool('/tmp'),
  retrieve: createRetrieveOutputTool('/tmp', ref),
  workflow: createWorkflowTool('/tmp', ref),
  surface: createSurfaceTools(ref),
  browser: createBrowserTools(ref),
};

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
let GD = 0, GP = 0, GN = 0;
const rows: Array<{ g: string; n: number; d: number; p: number; tot: number }> = [];

for (const [g, tools] of Object.entries(groups)) {
  let d = 0, p = 0;
  for (const t of tools) {
    d += bytes((t as any).description ?? '');
    try { p += bytes(JSON.stringify((z as any).toJSONSchema((t as any).parameters))); } catch { /* no params */ }
  }
  GD += d; GP += p; GN += tools.length;
  rows.push({ g, n: tools.length, d, p, tot: d + p });
}

rows.sort((a, b) => b.tot - a.tot);
console.log(`GRAND: ${GN} tools, desc=${GD}B, paramSchema=${GP}B, total=${GD + GP}B (~${Math.round((GD + GP) / 4)} tokens/turn)\n`);
console.log('group            tools  descB  paramB  totalB');
for (const r of rows) {
  console.log(`${r.g.padEnd(16)} ${String(r.n).padStart(3)}  ${String(r.d).padStart(6)} ${String(r.p).padStart(6)}  ${String(r.tot).padStart(6)}`);
}
