import { describe, it, expect, vi, afterAll } from 'vitest';

/**
 * spec-report-intent-tool: the prompt must name `report_intent` and instruct
 * the model to call it once on the first turn of a new session.
 *
 * A capability listed in the prompt but absent from the tool list is the class
 * of bug that removed the SDK's original `report_intent` from the prose. This
 * oracle prevents the mirror bug: the tool exists again, so the prompt line
 * must too — and it must frame the argument as USER intent, not agent activity.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const env = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  const home = mkdtempSync(join(tmpdir(), 'caco-prompt-report-intent-'));
  mkdirSync(join(home, '.caco'), { recursive: true });
  return { home };
});
void mkdtempSync; void mkdirSync; void tmpdir; void join;

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, homedir: () => env.home, default: { ...actual, homedir: () => env.home } };
});

vi.mock('../../src/applet-store.js', () => ({ listApplets: async () => [] }));

import { buildSystemMessage } from '../../src/prompts.js';

afterAll(() => { rmSync(env.home, { recursive: true, force: true }); });

describe('system prompt names report_intent', () => {
  it('includes exactly one report_intent nudge in the Behavior section', async () => {
    const content = (await buildSystemMessage()).content;
    const occurrences = content.match(/report_intent/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it('frames the argument as USER intent, not agent activity', async () => {
    const content = (await buildSystemMessage()).content;
    // Find the nudge line and inspect its content.
    const line = content.split('\n').find(l => l.includes('report_intent'));
    expect(line).toBeDefined();
    expect(line!).toMatch(/USER/);
    expect(line!).toMatch(/not.*current activity/i);
  });

  it('locates the nudge in the Behavior section, not scattered', async () => {
    const content = (await buildSystemMessage()).content;
    const behaviorStart = content.indexOf('## Behavior');
    expect(behaviorStart).toBeGreaterThan(0);
    const behaviorSection = content.slice(behaviorStart);
    expect(behaviorSection).toContain('report_intent');
  });
});
