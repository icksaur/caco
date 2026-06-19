import type { ToolResultObject } from '@github/copilot-sdk';
import { storeOutput } from '../output-store.js';
import { shapeOutput } from './shape.js';

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
export function createObservationHook(sessionCwd: string) {
  return (input: PostToolUseInput): PostToolUseOutput | void => {
    const result = input.toolResult;
    if (!result || typeof result.textResultForLlm !== 'string') return;

    const raw = result.textResultForLlm;
    const decision = shapeOutput(input.toolName, raw);
    if (!decision) return;

    const id = storeOutput(sessionCwd, raw, { type: 'raw', command: input.toolName });
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
