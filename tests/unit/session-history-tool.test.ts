/**
 * Tests for src/session-history-tool.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { isReadOnlyQuery, runSessionStoreQuery } from '../../src/session-history-tool.js';

function buildFixtureDb(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      summary TEXT,
      updated_at TEXT
    );
    INSERT INTO sessions (id, summary, updated_at) VALUES
      ('s1', 'first session',  '2026-05-01T10:00:00Z'),
      ('s2', 'second session', '2026-05-02T10:00:00Z'),
      ('s3', NULL,             '2026-05-03T10:00:00Z');
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT
    );
    INSERT INTO turns (id, session_id, role, content) VALUES
      (1, 's1', 'user',      'hello'),
      (2, 's1', 'assistant', 'world'),
      (3, 's2', 'user',      'ping');
  `);
  db.close();
}

describe('isReadOnlyQuery', () => {
  it('accepts SELECT', () => {
    expect(isReadOnlyQuery('SELECT * FROM sessions')).toBe(true);
    expect(isReadOnlyQuery('select * from sessions')).toBe(true);
    expect(isReadOnlyQuery('  SELECT 1')).toBe(true);
  });

  it('accepts WITH (CTE)', () => {
    expect(isReadOnlyQuery('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(true);
  });

  it('accepts PRAGMA', () => {
    expect(isReadOnlyQuery('PRAGMA table_info(sessions)')).toBe(true);
  });

  it('rejects INSERT', () => {
    expect(isReadOnlyQuery('INSERT INTO sessions VALUES (1)')).toBe(false);
  });

  it('rejects UPDATE', () => {
    expect(isReadOnlyQuery('UPDATE sessions SET id=1')).toBe(false);
  });

  it('rejects DELETE', () => {
    expect(isReadOnlyQuery('DELETE FROM sessions')).toBe(false);
  });

  it('rejects DROP', () => {
    expect(isReadOnlyQuery('DROP TABLE sessions')).toBe(false);
  });

  it('rejects ATTACH', () => {
    expect(isReadOnlyQuery("ATTACH 'other.db' AS o")).toBe(false);
  });

  it('rejects empty / whitespace-only', () => {
    expect(isReadOnlyQuery('')).toBe(false);
    expect(isReadOnlyQuery('   ')).toBe(false);
  });

  it('rejects multi-statement that starts with a non-SELECT', () => {
    expect(isReadOnlyQuery('DROP TABLE x; SELECT 1')).toBe(false);
  });
});

describe('runSessionStoreQuery', () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'caco-session-store-test-'));
    dbPath = join(tmp, 'session-store.db');
    buildFixtureDb(dbPath);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns columns + rows for a SELECT', () => {
    const result = runSessionStoreQuery(dbPath, 'SELECT id, summary FROM sessions ORDER BY id');
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unreachable');
    expect(result.columns).toEqual(['id', 'summary']);
    expect(result.rows).toEqual([
      ['s1', 'first session'],
      ['s2', 'second session'],
      ['s3', null],
    ]);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBeUndefined();
  });

  it('handles NULL columns', () => {
    const result = runSessionStoreQuery(dbPath, 'SELECT summary FROM sessions WHERE id = \'s3\'');
    if ('error' in result) throw new Error('expected ok');
    expect(result.rows).toEqual([[null]]);
  });

  it('returns empty result for a query with no rows', () => {
    const result = runSessionStoreQuery(dbPath, 'SELECT * FROM sessions WHERE id = \'nope\'');
    if ('error' in result) throw new Error('expected ok');
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it('rejects a write query before opening the DB', () => {
    const result = runSessionStoreQuery(dbPath, 'DELETE FROM sessions');
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('unreachable');
    expect(result.error).toMatch(/SELECT/);
  });

  it('returns error when DB file does not exist', () => {
    const result = runSessionStoreQuery(join(tmp, 'missing.db'), 'SELECT 1');
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).toMatch(/not found/);
  });

  it('returns error for invalid SQL', () => {
    const result = runSessionStoreQuery(dbPath, 'SELECT * FROM nonexistent_table');
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).toMatch(/no such table/i);
  });

  it('joins across tables', () => {
    const result = runSessionStoreQuery(
      dbPath,
      'SELECT s.id, t.content FROM sessions s JOIN turns t ON t.session_id = s.id ORDER BY t.id'
    );
    if ('error' in result) throw new Error('expected ok');
    expect(result.rowCount).toBe(3);
    expect(result.rows[0]).toEqual(['s1', 'hello']);
  });

  it('PRAGMA returns schema info', () => {
    const result = runSessionStoreQuery(dbPath, 'PRAGMA table_info(sessions)');
    if ('error' in result) throw new Error('expected ok');
    expect(result.columns).toContain('name');
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('CTE (WITH) works', () => {
    const result = runSessionStoreQuery(
      dbPath,
      'WITH counts AS (SELECT session_id, COUNT(*) AS n FROM turns GROUP BY session_id) SELECT session_id, n FROM counts ORDER BY session_id'
    );
    if ('error' in result) throw new Error('expected ok');
    expect(result.rows).toEqual([
      ['s1', 2],
      ['s2', 1],
    ]);
  });

  it('truncates rows over the 500 cap and flags truncated', () => {
    const local = join(tmp, 'big.db');
    const db = new DatabaseSync(local);
    db.exec('CREATE TABLE big (n INTEGER)');
    db.exec('BEGIN');
    const stmt = db.prepare('INSERT INTO big (n) VALUES (?)');
    for (let i = 0; i < 600; i++) stmt.run(i);
    db.exec('COMMIT');
    db.close();

    const result = runSessionStoreQuery(local, 'SELECT n FROM big ORDER BY n');
    if ('error' in result) throw new Error('expected ok');
    expect(result.rowCount).toBe(600);
    expect(result.rows.length).toBe(500);
    expect(result.truncated).toBe(true);
  });
});
