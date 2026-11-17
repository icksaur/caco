/**
 * O10: the read-only import/call restriction on the overview files fires.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ESLint } from 'eslint';
import { join } from 'path';

const root = process.cwd();
const eslint = new ESLint({ cwd: root });

async function lint(file: string, code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath: join(root, file) });
  return r.messages.map(m => m.ruleId ?? m.message);
}

// Type-aware linting builds the TS program on first use; under a loaded full run
// that can take well over the default timeout.
vi.setConfig({ testTimeout: 60_000 });

describe('overview read-only lint rule (O10)', () => {
  beforeAll(async () => { await lint('src/session-overview-io.ts', 'export {};\n'); }, 180_000);

  it.each([
    ['src/session-overview-io.ts', "import { updateSessionMeta } from './storage.js';\nexport const x = updateSessionMeta;\n"],
    ['src/session-overview-io.ts', "import { ensureSessionMeta } from './session-meta-store.js';\nexport const x = ensureSessionMeta;\n"],
    ['src/session-overview-io.ts', "import { activityVersion } from './activity-version.js';\nexport const x = activityVersion;\n"],
    ['src/session-overview-io.ts', "import { unobservedTracker } from './unobserved-tracker.js';\nexport const x = unobservedTracker;\n"],
    ['src/session-overview-io.ts', "import { rotateSessionHistory } from './session-history-rotation.js';\nexport const x = rotateSessionHistory;\n"],
    ['src/routes/overview.ts', "import { dispatchMessage } from './session-messages.js';\nexport const x = dispatchMessage;\n"],
    ['src/routes/overview.ts', "import { wakeManager } from '../wake-runtime.js';\nexport const x = wakeManager;\n"],
    ['src/session-overview.ts', "import { setSessionMeta } from './storage.js';\nexport const x = setSessionMeta;\n"],
  ])('%s: forbidden import is reported', async (file, code) => {
    expect(await lint(file, code)).toContain('no-restricted-imports');
  });

  it.each([
    "declare const sessionManager: { resume(id: string): void };\nsessionManager.resume('x');\n",
    "declare const sessionManager: { getHistory(id: string): void };\nsessionManager.getHistory('x');\n",
    "declare const t: { markObserved(id: string): void };\nt.markObserved('x');\n",
    "declare function updateSessionMeta(id: string, f: () => void): void;\nupdateSessionMeta('x', () => {});\n",
  ])('a write or resume call is reported: %s', async (code) => {
    expect(await lint('src/session-overview-io.ts', code)).toContain('no-restricted-syntax');
  });

  it('the read imports the collector uses are allowed', async () => {
    const code = "import { readSessionMeta } from './session-meta-store.js';\nexport const x = readSessionMeta;\n";
    expect(await lint('src/session-overview-io.ts', code)).toEqual([]);
  });

  it('the rule does not apply to other files', async () => {
    const code = "import { updateSessionMeta } from './storage.js';\nexport const x = updateSessionMeta;\n";
    expect(await lint('src/wake-runtime.ts', code)).not.toContain('no-restricted-imports');
  });
});
