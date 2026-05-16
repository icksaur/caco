/**
 * Session History Query Tool
 * 
 * Provides read-only SQL access to ~/.copilot/session-store.db —
 * the global session history database maintained by the Copilot CLI.
 * 
 * Backed by node:sqlite (Node 22+ built-in). No native dependencies and
 * no WASM blob — the previous sql.js backend pulled in ~19 MB of WASM
 * to do exactly this.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = join(homedir(), '.copilot', 'session-store.db');
const SELECT_RE = /^\s*(SELECT|WITH|PRAGMA)\b/i;
const ROW_LIMIT = 500;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated?: boolean;
}

export interface QueryError {
  error: string;
}

export type QueryResponse = QueryResult | QueryError;

/** Pure predicate: is this a query we'll allow? */
export function isReadOnlyQuery(query: string): boolean {
  return SELECT_RE.test(query);
}

/**
 * Run a SELECT-shaped query against a SQLite database file on disk.
 * Returns either { columns, rows, rowCount, truncated? } or { error }.
 * The query gate is applied here so tests don't need to spin up a tool.
 */
export function runSessionStoreQuery(dbPath: string, query: string): QueryResponse {
  if (!isReadOnlyQuery(query)) {
    return { error: 'Only SELECT, WITH, and PRAGMA queries are allowed.' };
  }

  if (!existsSync(dbPath)) {
    return { error: `Session store database not found at ${dbPath}` };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(query);
    // setReadBigInts(false) keeps INTEGER columns as Number (matches the
    // sql.js shape). Acceptable: session-store IDs are timestamps and
    // counters that fit safely in a JS number.
    stmt.setReadBigInts(false);
    const rawRows = stmt.all() as Array<Record<string, unknown>>;
    if (rawRows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rawRows[0]);
    const allRows = rawRows.map(row => columns.map(c => row[c]));
    return {
      columns,
      rows: allRows.slice(0, ROW_LIMIT),
      rowCount: allRows.length,
      ...(allRows.length > ROW_LIMIT && { truncated: true }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

export function createSessionHistoryTool() {
  const tool = defineTool('caco_session_store_sql', {
    description: `Execute read-only SQL queries against the global session history database (~/.copilot/session-store.db).

This database contains cross-session history maintained by the Copilot CLI. Available tables: sessions, turns, checkpoints, session_files, session_refs, search_index.

Use this to query conversation history across all sessions — what was discussed, when, which files were changed, etc. Only SELECT queries are allowed.

Example: SELECT s.id, s.summary FROM sessions s ORDER BY s.updated_at DESC LIMIT 10`,
    parameters: z.object({
      query: z.string().describe('SQL query (SELECT only). Tables: sessions, turns, checkpoints, session_files, session_refs'),
    }),
    handler: async ({ query }) => runSessionStoreQuery(DB_PATH, query),
  });

  return [tool];
}
