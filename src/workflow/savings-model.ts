import {
  WORKFLOW_AVG_TOOLCALL_TOKENS,
  WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN,
} from '../config.js';
import { BYTES_PER_TOKEN } from '../session-throughput.js';
import { estimateSavedTokens } from './savings.js';

export interface WorkflowSavingsInput {
  /** Total bytes the facade returned to the script (would have entered context). */
  observedBytes: number;
  /** Bytes the workflow result actually injects back (emitted value + shaped logs). */
  injectedBytes: number;
  /** Facade calls made (virtual tool calls). */
  commandCount: number;
  /** Bytes of the workflow script the model wrote (this run's code arg). */
  codeBytes: number;
  /** Current context-window tokens (previous round trip's prompt), 0 when unknown. */
  windowTokens: number;
}

export interface WorkflowSavingsBreakdown {
  /** max(0, commandCount - 1), capped — facade calls collapsed into one workflow. */
  virtualToolCallsAvoided: number;
  /** Round trips saved = virtualToolCallsAvoided (each avoided call would have
   *  replayed the window). Drives window-replay tokens and time saved. */
  roundTripsSaved: number;
  /** One-time output kept out of context entirely (input class). Net headline. */
  freshInputTokensSaved: number;
  /** Window replay = roundTripsSaved * window (cache class). The dominant term:
   *  each avoided round trip would have re-sent the whole context window. */
  cacheReplayTokensSaved: number;
  /** Signed: code tokens spent minus tool-call arg tokens avoided (output class). */
  netOutputTokensSpent: number;
}

function toTokens(bytes: number): number {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.round(b / BYTES_PER_TOKEN);
}

/**
 * Per-run workflow savings math (pure; no session state). Compounding (a
 * session-stateful, deferred accrual of freshInputTokensSaved) and credit/time
 * pricing live in session-throughput, not here.
 *
 * The net headline is the sum of: window-replay (roundTripsSaved * window, the
 * dominant cache-class term — each avoided round trip would have re-sent the whole
 * context window), one-time freshInputTokensSaved (input class) + later compounding
 * (cache class), minus netOutputTokensSpent (output class).
 */
export function estimateWorkflowSavings(input: WorkflowSavingsInput): WorkflowSavingsBreakdown {
  const commandCount = Number.isFinite(input.commandCount) && input.commandCount > 0 ? Math.floor(input.commandCount) : 0;
  const virtualToolCallsAvoided = Math.min(Math.max(0, commandCount - 1), WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN);
  const roundTripsSaved = virtualToolCallsAvoided;

  const freshInputTokensSaved = estimateSavedTokens(input.observedBytes, input.injectedBytes);

  const window = Number.isFinite(input.windowTokens) && input.windowTokens > 0 ? Math.floor(input.windowTokens) : 0;
  const cacheReplayTokensSaved = roundTripsSaved * window;

  const codeTokens = toTokens(input.codeBytes);
  const netOutputTokensSpent = codeTokens - virtualToolCallsAvoided * WORKFLOW_AVG_TOOLCALL_TOKENS;

  return {
    virtualToolCallsAvoided,
    roundTripsSaved,
    freshInputTokensSaved,
    cacheReplayTokensSaved,
    netOutputTokensSpent,
  };
}
