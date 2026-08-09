/**
 * End-to-end verification of the real production translation.
 *
 * Imports Caco's own buildSystemMessage/toSdkSystemMessage and sends the exact
 * payload they produce to a real SDK session in the canary fixture, then asks
 * the model to report the markers. This exercises the shipped code path rather
 * than a hand-written approximation of it.
 *
 * Usage: npx tsx tools/instr-lab/verify-fix.ts <labroot> [model]
 */
import { CopilotClient } from '@github/copilot-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildSystemMessage, resolveSystemMessage, toSdkSystemMessage } from '../../src/prompts.js';

const LAB = process.argv[2];
const MODEL = process.argv[3] ?? 'claude-sonnet-4.6';
if (!LAB) { console.error('usage: verify-fix.ts <labroot> [model]'); process.exit(2); }

const CWD = join(LAB, 'proj');
const tokens = Object.fromEntries(
  readFileSync(join(LAB, 'tokens.env'), 'utf8').trim().split('\n').map((l) => l.split('=')),
) as Record<string, string>;
const PROMPT = readFileSync(new URL('./probe.txt', import.meta.url), 'utf8');

const caco = resolveSystemMessage(await buildSystemMessage(), CWD);
const payload = toSdkSystemMessage(caco);
console.log('caco intent mode :', caco.mode);
console.log('sent to SDK mode :', payload.mode);
console.log('sections         :', payload.mode === 'customize' ? Object.keys(payload.sections).join(', ') : '(n/a)');
console.log('mentions custom_instructions:',
  payload.mode === 'customize' && 'custom_instructions' in payload.sections);

const client = new CopilotClient({ workingDirectory: CWD });
const session = await client.createSession({
  model: MODEL, streaming: false, workingDirectory: CWD,
  systemMessage: payload, configDirectory: join(homedir(), '.copilot'), enableConfigDiscovery: true,
} as Parameters<typeof client.createSession>[0]);

const res = await session.sendAndWait({ prompt: PROMPT }, 180_000) as { content?: string } | string;
const text = typeof res === 'string' ? res : (res?.content ?? JSON.stringify(res));

const log = join(homedir(), '.copilot', 'session-state', session.sessionId, 'events.jsonl');
const sys = readFileSync(log, 'utf8').split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((e) => e?.type === 'system.message')?.data?.content ?? '';

console.log('\nprompt chars     :', sys.length);
console.log('caco prose present:', sys.includes('You are an AI assistant in Caco'));
console.log('sdk prose present :', /environment_limitations|GitHub Copilot CLI, a terminal assistant/.test(sys));
console.log('custom_instruction block:', sys.includes('<custom_instruction>'));
console.log();
for (const k of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'HOTEL']) {
  console.log(k.padEnd(8), text.includes(tokens[k]) ? 'LOADED' : 'absent');
}
console.log('GOLF     ', /GOLF\s*=\s*ABSENT/.test(text) ? 'control-ok' : 'CONTROL-FAILED');

await session.destroy?.();
await client.stop?.();
