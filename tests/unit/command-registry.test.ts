import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILTIN_COMMANDS, findCommand } from '../../public/ts/command-registry.js';

const README = readFileSync(join(__dirname, '../../README.md'), 'utf-8');

describe('BUILTIN_COMMANDS', () => {
  it('has no duplicate names', () => {
    const names = BUILTIN_COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every command has a non-empty description', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.description.length, `${cmd.name} missing description`).toBeGreaterThan(0);
    }
  });

  for (const cmd of BUILTIN_COMMANDS) {
    it(`/${cmd.name} has a registered handler`, () => {
      expect(findCommand(cmd.name), `/${cmd.name} declared in BUILTIN_COMMANDS but never registered via registerBuiltin`).toBeDefined();
    });
  }

  for (const cmd of BUILTIN_COMMANDS) {
    it(`/${cmd.name} is documented in README.md`, () => {
      expect(README, `/${cmd.name} not found in README.md`).toContain(`/${cmd.name}`);
    });
  }
});
