import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MEMORY_FILE = join(homedir(), '.caco', 'memory.json');
const MEMORY_BACKUP = join(homedir(), '.caco', 'memory.json.bak');
export const MAX_ENTRIES = 50;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type MemoryStore = Record<string, string>;

export function readMemory(): MemoryStore {
  try {
    if (!existsSync(MEMORY_FILE)) return {};
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeMemory(store: MemoryStore): void {
  const dir = join(homedir(), '.caco');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempFile = MEMORY_FILE + '.tmp';
  writeFileSync(tempFile, JSON.stringify(store, null, 2) + '\n');
  if (existsSync(MEMORY_FILE)) copyFileSync(MEMORY_FILE, MEMORY_BACKUP);
  renameSync(tempFile, MEMORY_FILE);
}

export function formatMemoryForPrompt(): string {
  const store = readMemory();
  // Sort keys so identical memory CONTENT always serializes to identical BYTES,
  // regardless of set/delete insertion order — this block sits in the cacheable
  // system-prompt prefix, so a reordered key would bust cross-session cache reuse
  // (spec-prompt-stable-prefix).
  const keys = Object.keys(store).sort();
  if (keys.length === 0) return '';
  const lines = keys.map(k => `- **${k}**: ${store[k]}`);
  return `\n\n## User Memory\n${lines.join('\n')}`;
}

export function createMemoryTools() {
  const memory = defineTool('caco_memory', {
    description: 'Persistent cross-session memory (global key-value, max 50 slug-keyed entries). action="read" returns all entries + capacity (memory is injected at session start; read for the latest if it may have changed). action="set" stores/updates key→value. action="delete" removes key. Use set/delete when the user says "remember", "forget", "always", or "never". One fact per key; prefer updating an existing key.',

    parameters: z.object({
      action: z.enum(['read', 'set', 'delete']).describe('read all, set a key, or delete a key'),
      key: z.string().optional().describe('Slug key (lowercase, hyphens, numbers); required for set/delete'),
      value: z.string().optional().describe('Value to store; required for set'),
    }),

    handler: async ({ action, key, value }) => {
      const store = readMemory();
      const meta = () => ({ count: Object.keys(store).length, capacity: MAX_ENTRIES });

      if (action === 'read') {
        return { textResultForLlm: JSON.stringify({ entries: store, ...meta() }) };
      }

      if (!key || !SLUG_RE.test(key)) {
        return { textResultForLlm: `Error: ${action} requires a valid slug key (lowercase, hyphens, numbers, e.g., "preferred-language").` };
      }

      if (action === 'delete') {
        if (key in store) {
          delete store[key];
          writeMemory(store);
          return { textResultForLlm: JSON.stringify({ ok: true, deleted: key, ...meta() }) };
        }
        return { textResultForLlm: JSON.stringify({ ok: true, notFound: key, ...meta() }) };
      }

      const trimmed = (value ?? '').trim();
      if (!trimmed) {
        return { textResultForLlm: 'Error: set requires a non-empty value (use action="delete" to remove a key).' };
      }
      if (!(key in store) && Object.keys(store).length >= MAX_ENTRIES) {
        return { textResultForLlm: `Error: memory is full (${MAX_ENTRIES}/${MAX_ENTRIES}). Delete an entry before adding a new one.` };
      }

      store[key] = trimmed;
      writeMemory(store);
      return { textResultForLlm: JSON.stringify({ ok: true, key, ...meta() }) };
    },
  });

  return [memory];
}
