/**
 * shell route harness (Mechanism B, docs/spec-backend-coverage-80.md). The shell
 * router has no singleton deps, so we mount it directly and drive real requests,
 * exercising validation branches plus success / non-zero-exit / command-not-found
 * paths with `node` as a portable, always-present binary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

let server: Server;
let base: string;
let dir: string;
let filePath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'caco-shell-harness-'));
  filePath = join(dir, 'afile.txt');
  writeFileSync(filePath, 'x');
  const { router } = await import('../../src/routes/shell.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const shell = (body: unknown) =>
  fetch(`${base}/shell`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('shell route harness', () => {
  it('400s a missing command', async () => {
    const r = await shell({ args: [] });
    expect(r.status).toBe(400);
  });

  it('400s when args is not an array of strings', async () => {
    const r = await shell({ command: 'node', args: [1, 2] });
    expect(r.status).toBe(400);
  });

  it('400s a non-absolute cwd', async () => {
    const r = await shell({ command: 'node', cwd: 'relative/path' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/absolute/i);
  });

  it('400s a cwd that is a file, not a directory', async () => {
    const r = await shell({ command: 'node', cwd: filePath });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not a directory/i);
  });

  it('400s a cwd that does not exist', async () => {
    const r = await shell({ command: 'node', cwd: join(dir, 'nope') });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/does not exist/i);
  });

  it('runs a successful command and returns code 0 with sanitized stdout', async () => {
    const r = await shell({
      command: 'node',
      args: ['-e', 'process.stdout.write("hello\\r\\nworld")'],
      cwd: dir,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.code).toBe(0);
    expect(body.stdout).toBe('hello\nworld');
  });

  it('returns the real non-zero exit code as HTTP 200', async () => {
    const r = await shell({
      command: 'node',
      args: ['-e', 'process.exit(3)'],
      cwd: dir,
    });
    expect(r.status).toBe(200);
    expect((await r.json()).code).toBe(3);
  });

  it('500s a command that does not exist (ENOENT)', async () => {
    const r = await shell({
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
      cwd: dir,
    });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/not found/i);
  });
});
