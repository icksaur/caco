/** A ranged read of a single file. */
export interface ReadResult {
  /** Path relative to the session directory. */
  path: string;
  /** Total number of '\n'-split segments. A newline-terminated file reports N+1, so grep's max line is totalLines - 1. */
  totalLines: number;
  /** 1-based inclusive line range actually returned. */
  range: [start: number, end: number];
  /** The selected lines joined by '\n' (no trailing newline added). */
  text: string;
}

/** One matching line from a grep. */
export interface GrepMatch {
  /** Path relative to the session directory. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matching line text (trailing newline stripped). */
  text: string;
}

export interface GrepOptions {
  /** Restrict the search to this subtree (relative to the session directory). */
  path?: string;
  /** rg-style glob to include files, e.g. '*.ts'. Exclusions ('!*.test.ts') work with rg but are ignored by the JS fallback. */
  glob?: string;
  /** Case-insensitive match. */
  ignoreCase?: boolean;
}

/** Bad input the caller should surface verbatim (path/type/size), not a crash. */
export class WorkflowInputError extends Error {}
