import type { ToolResultObject } from '@github/copilot-sdk';
import { storeOutput } from '../output-store.js';
import { shapeOutput } from './shape.js';
import { recordShapingSavings, BYTES_PER_TOKEN } from '../session-throughput.js';
import type { SessionIdRef } from '../types.js';
import { requireSessionId } from '../session-id-ref.js';

interface PostToolUseInput {
  toolName: string;
  toolArgs?: unknown;
  toolResult: ToolResultObject;
}

interface PostToolUseOutput {
  modifiedResult?: ToolResultObject;
}

/**
 * onPostToolUse handler: replace large tool output with a failure-preserving
 * summary and stash the raw output for recovery via `retrieve_output`. Only
 * `textResultForLlm` is touched; all other result fields pass through.
 */
export function createObservationHook(sessionCwd: string, sessionRef: SessionIdRef) {
  return (input: PostToolUseInput): PostToolUseOutput | void => {
    const result = input.toolResult;
    if (!result || typeof result.textResultForLlm !== 'string') return;

    const raw = result.textResultForLlm;
    const decision = shapeOutput(input.toolName, raw);
    if (!decision) return;

    const id = storeOutput(requireSessionId(sessionRef), sessionCwd, raw, { type: 'raw', command: input.toolName });
    recordShapingSavings(requireSessionId(sessionRef), Math.round((decision.rawBytes - decision.shapedBytes) / BYTES_PER_TOKEN));
    const rawKb = (decision.rawBytes / 1024).toFixed(1);
    const shapedKb = (decision.shapedBytes / 1024).toFixed(1);
    const handle =
      `\n\n[Output shaped by '${decision.shaperId}': showing ${shapedKb} KB of ` +
      `${rawKb} KB. Full raw output: retrieve_output id="${id}" — supports ` +
      '{ range: [start, end] } or { grep: "pattern" }.]';

    return {
      modifiedResult: { ...result, textResultForLlm: decision.shaped + handle },
    };
  };
}
