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
import { disabledToolNames } from '../src/tool-registry.js';
import { createAppletTools } from '../src/applet-tools.js';
import { createAgentTools } from '../src/agent-tools.js';
import { createMcpAuthTools } from '../src/mcp-auth-tools.js';
import { createDocsTool } from '../src/dev-docs-tool.js';
import { createDelegateTool } from '../src/delegate-tool.js';
import { createSessionHistoryTool } from '../src/session-history-tool.js';
import { createMemoryTools } from '../src/memory-tool.js';
import { createIndexTool } from '../src/index-tool.js';
import { createRetrieveOutputTool } from '../src/observe/retrieve-tool.js';
import { createWorkflowTool } from '../src/workflow/tool.js';
import { createSurfaceTools } from '../src/surface-tools.js';
import { createBrowserTools } from '../src/browser-tools.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ref = { id: 'measure' } as any;
const noop = (() => {}) as any;

const groups: Record<string, any[]> = {
  applet: createAppletTools('/tmp', ref, noop),
  agent: createAgentTools(ref, () => undefined as any),
  'mcp-auth': createMcpAuthTools(),
  'dev-docs': createDocsTool('/tmp'),
  delegate: createDelegateTool(ref),
  'session-history': createSessionHistoryTool(),
  memory: createMemoryTools(),
  index: createIndexTool('/tmp'),
  retrieve: createRetrieveOutputTool('/tmp', ref),
  workflow: createWorkflowTool('/tmp', ref),
  surface: createSurfaceTools(ref),
  browser: createBrowserTools(ref),
};

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const disabled = disabledToolNames();
let GD = 0, GP = 0, GN = 0;          // all registered (pre-filter)
let SD = 0, SP = 0, SN = 0;          // shipped (after disable filter)
const rows: Array<{ g: string; n: number; d: number; p: number; tot: number }> = [];

for (const [g, tools] of Object.entries(groups)) {
  let d = 0, p = 0;
  for (const t of tools) {
    const td = bytes((t as any).description ?? '');
    let tp = 0;
    try { tp = bytes(JSON.stringify((z as any).toJSONSchema((t as any).parameters))); } catch { /* no params */ }
    d += td; p += tp;
    if (!disabled.has(String((t as any).name).toLowerCase())) { SD += td; SP += tp; SN++; }
  }
  GD += d; GP += p; GN += tools.length;
  rows.push({ g, n: tools.length, d, p, tot: d + p });
}

rows.sort((a, b) => b.tot - a.tot);
console.log(`REGISTERED: ${GN} tools, desc=${GD}B, paramSchema=${GP}B, total=${GD + GP}B (~${Math.round((GD + GP) / 4)} tokens/turn)`);
console.log(`SHIPPED   : ${SN} tools, desc=${SD}B, paramSchema=${SP}B, total=${SD + SP}B (~${Math.round((SD + SP) / 4)} tokens/turn)  [disabled: ${[...disabled].join(', ') || 'none'}]\n`);
console.log('group            tools  descB  paramB  totalB');
for (const r of rows) {
  console.log(`${r.g.padEnd(16)} ${String(r.n).padStart(3)}  ${String(r.d).padStart(6)} ${String(r.p).padStart(6)}  ${String(r.tot).padStart(6)}`);
}
