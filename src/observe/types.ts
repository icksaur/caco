export interface ShapeResult {
  shaped: string;
  preserved: number;
  dropped: number;
}

export interface ShaperContext {
  toolName: string;
  argv?: string;
}

export interface Shaper {
  id: string;
  /** 0 = no match; higher = stronger. Highest scorer wins, else `generic`. */
  detect(raw: string, ctx: ShaperContext): number;
  shape(raw: string): ShapeResult;
}

/** Runtime shell-class tools whose output is semantically shaped (spike-verified). */
export const SHELL_TOOLS = new Set([
  'bash',
  'powershell',
  'local_shell',
  'read_bash',
  'read_powershell',
]);

/** Below this, output passes through untouched (not worth shaping). */
export const SHAPE_THRESHOLD_BYTES = 8 * 1024;

/**
 * Hard byte ceiling for the generic floor. The floor ALWAYS reduces output
 * below this regardless of line count, so a handful of huge lines (or one giant
 * line) can never slip past the hook unbounded. This is what makes the hook the
 * real bounding authority once the runtime truncation threshold is raised.
 */
export const GENERIC_HARD_CAP_BYTES = 16 * 1024;

/** Max preserved failure blocks before eliding with a count. */
export const MAX_FAILURES = 60;

/** Generic shaper head/tail line counts. */
export const GENERIC_HEAD_LINES = 40;
export const GENERIC_TAIL_LINES = 40;

/** Cap on a single retrieve_output response (range/grep narrow within this). */
export const RETRIEVE_OUTPUT_CAP_BYTES = 64 * 1024;

/**
 * Runtime truncation ceiling. Set on COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES so the
 * onPostToolUse hook receives raw output up to this size and is the single
 * bounding authority (spike finding). Above this the runtime still truncates.
 */
export const OBS_RAW_CEILING_BYTES = 2 * 1024 * 1024;
