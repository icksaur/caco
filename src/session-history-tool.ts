/**
 * Session History Query Tool
 * 
 * Provides read-only SQL access to ~/.copilot/session-store.db —
 * the global session history database maintained by the Copilot CLI.
 * 
 * This works around a limitation where SDK-spawned sessions don't get
 * the CLI's built-in session_store SQL routing.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';

const DB_PATH = join(homedir(), '.copilot', 'session-store.db');
const SELECT_RE = /^\s*(SELECT|WITH|PRAGMA)\b/i;

let initSqlJs: typeof import('sql.js').default | null = null;

async function loadSqlJs() {
  if (!initSqlJs) {
    const mod = await import('sql.js');
    initSqlJs = mod.default;
  }
  return initSqlJs();
}

export function createSessionHistoryTool() {
  const tool = defineTool('session_store_sql', {
    description: `Execute read-only SQL queries against the global session history database (~/.copilot/session-store.db).

This database contains cross-session history maintained by the Copilot CLI. Available tables: sessions, turns, checkpoints, session_files, session_refs, search_index.

Use this to query conversation history across all sessions — what was discussed, when, which files were changed, etc. Only SELECT queries are allowed.

Example: SELECT s.id, s.summary FROM sessions s ORDER BY s.updated_at DESC LIMIT 10`,
    parameters: z.object({
      query: z.string().describe('SQL query (SELECT only). Tables: sessions, turns, checkpoints, session_files, session_refs'),
    }),
    handler: async ({ query }) => {
      if (!SELECT_RE.test(query)) {
        return { error: 'Only SELECT, WITH, and PRAGMA queries are allowed.' };
      }

      if (!existsSync(DB_PATH)) {
        return { error: `Session store database not found at ${DB_PATH}` };
      }

      try {
        const SQL = await loadSqlJs();
        const buffer = readFileSync(DB_PATH);
        const db = new SQL.Database(buffer);

        try {
          const results = db.exec(query);
          if (!results.length) {
            return { columns: [], rows: [], rowCount: 0 };
          }

          const { columns, values } = results[0];
          return {
            columns,
            rows: values.slice(0, 500),
            rowCount: values.length,
            truncated: values.length > 500,
          };
        } finally {
          db.close();
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  return [tool];
}
