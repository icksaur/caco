import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MEMORY_FILE = join(homedir(), '.caco', 'memory.json');
const MEMORY_BACKUP = join(homedir(), '.caco', 'memory.json.bak');
const MAX_ENTRIES = 50;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type MemoryStore = Record<string, string>;

function readMemory(): MemoryStore {
  try {
    if (!existsSync(MEMORY_FILE)) return {};
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeMemory(store: MemoryStore): void {
  const dir = join(homedir(), '.caco');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempFile = MEMORY_FILE + '.tmp';
  writeFileSync(tempFile, JSON.stringify(store, null, 2) + '\n');
  if (existsSync(MEMORY_FILE)) copyFileSync(MEMORY_FILE, MEMORY_BACKUP);
  renameSync(tempFile, MEMORY_FILE);
}

export function formatMemoryForPrompt(): string {
  const store = readMemory();
  const keys = Object.keys(store);
  if (keys.length === 0) return '';
  const lines = keys.map(k => `- **${k}**: ${store[k]}`);
  return `\n\n## User Memory\n${lines.join('\n')}`;
}

export function createMemoryTools() {
  const getMemory = defineTool('caco_get_memory', {
    description: 'Read all persistent memories (global — shared across all sessions, unlike per-session session_note). Returns key-value entries and capacity. Check before adding entries, or when you need the latest version (the injected copy may be stale).',

    parameters: z.object({}),

    handler: async () => {
      const store = readMemory();
      return {
        textResultForLlm: JSON.stringify({
          entries: store,
          count: Object.keys(store).length,
          capacity: MAX_ENTRIES,
        }),
      };
    },
  });

  const setMemory = defineTool('caco_set_memory', {
    description: 'Store or remove a persistent memory entry. Keys are slugs (lowercase, numbers, hyphens — e.g. "preferred-language"). Pass a value to store/update; omit or empty to delete. Use when the user says "remember", "forget", "always", or "never" about a preference. One fact per key; prefer updating an existing key.',

    parameters: z.object({
      key: z.string().describe('Slug-format key (lowercase, hyphens, numbers)'),
      value: z.string().optional().describe('Value to store. Empty or omitted = delete.'),
    }),

    handler: async ({ key, value }) => {
      if (!SLUG_RE.test(key)) {
        return { textResultForLlm: `Error: invalid key "${key}". Keys must be slugs (lowercase, hyphens, numbers, e.g., "preferred-language").` };
      }

      const store = readMemory();
      const trimmed = (value ?? '').trim();

      if (!trimmed) {
        if (key in store) {
          delete store[key];
          writeMemory(store);
          return { textResultForLlm: JSON.stringify({ ok: true, deleted: key, count: Object.keys(store).length, capacity: MAX_ENTRIES }) };
        }
        return { textResultForLlm: JSON.stringify({ ok: true, notFound: key, count: Object.keys(store).length, capacity: MAX_ENTRIES }) };
      }

      if (!(key in store) && Object.keys(store).length >= MAX_ENTRIES) {
        return { textResultForLlm: `Error: memory is full (${MAX_ENTRIES}/${MAX_ENTRIES}). Remove an entry before adding a new one.` };
      }

      store[key] = trimmed;
      writeMemory(store);
      return { textResultForLlm: JSON.stringify({ ok: true, key, count: Object.keys(store).length, capacity: MAX_ENTRIES }) };
    },
  });

  return [getMemory, setMemory];
}
