import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadInstanceIdentity } from '../../src/instance-identity.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'caco-instance-'));
const quiet = { log: () => {} };

describe('instance identity', () => {
  it('creates instance.json once with a uuid and the hostname, then reuses it', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'instance.json');
      const a = loadInstanceIdentity(file, { host: 'laptop', ...quiet });
      expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.name).toBe('laptop');
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(a);
      const b = loadInstanceIdentity(file, { host: 'other', ...quiet });
      expect(b).toEqual(a);
      expect(existsSync(`${file}.tmp.${process.pid}`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('CACO_INSTANCE_NAME overrides the name without rewriting the file', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'instance.json');
      const a = loadInstanceIdentity(file, { host: 'laptop', ...quiet });
      const b = loadInstanceIdentity(file, { host: 'laptop', nameOverride: ' devbox ', ...quiet });
      expect(b).toEqual({ id: a.id, name: 'devbox' });
      expect(JSON.parse(readFileSync(file, 'utf-8')).name).toBe('laptop');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['not json', '{"id":"nope"}', 'null'])('replaces an invalid file (%s) and keeps a backup', (content) => {
    const dir = tmp();
    try {
      const file = join(dir, 'instance.json');
      writeFileSync(file, content);
      const a = loadInstanceIdentity(file, { host: 'h', ...quiet });
      expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(content);
      expect(loadInstanceIdentity(file, { host: 'h', ...quiet }).id).toBe(a.id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a stored name is kept; a missing name falls back to the hostname', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'instance.json');
      const id = '11111111-2222-3333-4444-555555555555';
      writeFileSync(file, JSON.stringify({ id, name: 'named' }));
      expect(loadInstanceIdentity(file, { host: 'h', ...quiet })).toEqual({ id, name: 'named' });
      writeFileSync(file, JSON.stringify({ id }));
      expect(loadInstanceIdentity(file, { host: 'h', ...quiet })).toEqual({ id, name: 'h' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
