import { readdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { indexCore, type IndexCoreOptions } from '../index/core.js';
import { type IndexResult } from '../index/types.js';
import { buildFrames, type FramesOptions, type FramesResult } from '../index/frames.js';
import { getOutput } from '../output-store.js';
import { readFileRangeCore, grepCore, globCore, sliceLinesByRange } from './cores.js';
import { type ReadResult, type GrepMatch, type GrepOptions, WorkflowInputError } from './types.js';
import { getHostShell } from './shell.js';
import { validatePath } from '../path-utils.js';

const execFileAsync = promisify(execFile);

const CHILD_MAX_BUFFER = 64 * 1024 * 1024;

export interface ShResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Read-oriented surface a workflow script calls in-process. Methods reject (so a
 * script can try/catch) with WorkflowInputError on bad input. `rg` and `sh` are
 * escape hatches that run host tooling scoped to the session directory.
 */
export interface Facade {
  /** Structural skeleton of one source file (declarations with line ranges). */
  index(path: string, options?: IndexCoreOptions): Promise<IndexResult>;
  /** Definition(s) + ranked incoming callers of a symbol, with code snippets. */
  frames(symbol: string, options?: FramesOptions): Promise<FramesResult>;
  /** Read a 1-based inclusive line range (whole file if omitted). */
  read(path: string, range?: [start: number, end: number]): Promise<ReadResult>;
  /** Search file contents (rg-backed, JS fallback). */
  grep(pattern: string, options?: GrepOptions): Promise<GrepMatch[]>;
  /** Raw `rg` escape hatch; returns stdout. cwd is the session directory. */
  rg(args: string[]): Promise<string>;
  /** Expand a glob to sorted relative paths scoped to the session directory. */
  glob(pattern: string): Promise<string[]>;
  /** List directory entries (relative to the session directory). */
  list(path?: string): Promise<string[]>;
  /** Retrieve previously stored large tool output by id (optional line range). */
  retrieve(id: string, range?: [start: number, end: number]): Promise<string>;
  /** Run a shell command scoped to the session directory. Never throws on non-zero exit. */
  sh(command: string): Promise<ShResult>;
}

function sliceLines(text: string, range?: [number, number]): string {
  return sliceLinesByRange(text, range).text;
}

export function createFacade(sessionCwd: string): Facade {
  return {
    index: (path, options) => indexCore(sessionCwd, path, options),
    frames: (symbol, options) => buildFrames(sessionCwd, symbol, options),
    read: (path, range) => readFileRangeCore(sessionCwd, path, range),
    grep: (pattern, options) => grepCore(sessionCwd, pattern, options),
    glob: (pattern) => globCore(sessionCwd, pattern),
    async rg(args) {
      const { stdout } = await execFileAsync('rg', args, { cwd: sessionCwd, maxBuffer: CHILD_MAX_BUFFER });
      return stdout;
    },
    async list(path = '.') {
      const v = validatePath(sessionCwd, path);
      if (!v.valid) throw new WorkflowInputError(v.error);
      const entries = await readdir(v.resolved, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    },
    async retrieve(id, range) {
      const stored = getOutput(id);
      if (!stored) throw new WorkflowInputError(`output not found: ${id}`);
      const data = typeof stored.data === 'string' ? stored.data : stored.data.toString('utf8');
      return sliceLines(data, range);
    },
    async sh(command) {
      const shell = getHostShell();
      try {
        const { stdout, stderr } = await execFileAsync(shell.file, [...shell.flagArgs, command], { cwd: sessionCwd, maxBuffer: CHILD_MAX_BUFFER });
        return { stdout, stderr, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 };
      }
    },
  };
}

/**
 * Wrap a facade so every method's resolved value is passed to `account` (e.g. a
 * byte counter) before being returned unchanged. The explicit per-method
 * delegation keeps the return types exact and forces this wrapper to be updated
 * if the Facade surface changes (a compile error, not silent drift through an
 * untyped Proxy). `account` is a side effect only — it never transforms values.
 */
export function wrapFacadeForAccounting(facade: Facade, account: (value: unknown) => void): Facade {
  return {
    index: async (path, options) => { const r = await facade.index(path, options); account(r); return r; },
    frames: async (symbol, options) => { const r = await facade.frames(symbol, options); account(r); return r; },
    read: async (path, range) => { const r = await facade.read(path, range); account(r); return r; },
    grep: async (pattern, options) => { const r = await facade.grep(pattern, options); account(r); return r; },
    rg: async (args) => { const r = await facade.rg(args); account(r); return r; },
    glob: async (pattern) => { const r = await facade.glob(pattern); account(r); return r; },
    list: async (path) => { const r = await facade.list(path); account(r); return r; },
    retrieve: async (id, range) => { const r = await facade.retrieve(id, range); account(r); return r; },
    sh: async (command) => { const r = await facade.sh(command); account(r); return r; },
  };
}

/** Compact, model-facing description of the facade injected into workflow scripts. */
export const FACADE_API_SUMMARY = `\`caco\` facade (all async):
- caco.index(path, { language?, maxEntries? }) -> declaration skeleton with [start-end] line ranges.
- caco.frames(symbol, { glob?, file?, include?, context?, maxFrames? }) -> { definitions, incoming, truncated, notes }: a symbol's definition(s) + ranked callers with code snippets, in one call (collapses index+read chains). Cross-stack (TS/JS/C++/C#/shaders).
- caco.read(path, [start, end]?) -> { path, totalLines, range, text }. 1-based; whole file if range omitted.
- caco.grep(pattern, { path?, glob?, ignoreCase? }) -> [{ file, line, text }] (rg-backed).
- caco.rg(args[]) -> raw rg stdout.
- caco.glob(pattern) -> sorted relative paths.
- caco.list(path?) -> dir entries (dirs suffixed /).
- caco.retrieve(id, [start, end]?) -> stored large output by id.
- caco.sh(command) -> { stdout, stderr, code }. Runs in ${getHostShell().label} on this host (write ${getHostShell().label} syntax); never throws on non-zero exit.
Paths are scoped to the session dir (escaping throws), except \`rg\`/\`sh\` (unrestricted host tooling).`;

/** Hand-authored .d.ts injected so workflow scripts get types for \`caco\`. */
export const FACADE_DTS = `interface ReadResult { path: string; totalLines: number; range: [number, number]; text: string; }
interface GrepMatch { file: string; line: number; text: string; }
interface GrepOptions { path?: string; glob?: string; ignoreCase?: boolean; }
interface IndexCoreOptions { language?: string; maxEntries?: number; }
interface ShResult { stdout: string; stderr: string; code: number; }
interface Frame { kind: 'definition' | 'incoming'; file: string; line: number; code: string; confidence: 'exact' | 'heuristic'; }
interface FramesOptions { glob?: string; file?: string; include?: ('definition' | 'incoming')[]; context?: number; maxFrames?: number; maxFiles?: number; maxHits?: number; }
interface FramesResult { symbol: string; definitions: Frame[]; incoming: Frame[]; truncated: boolean; notes: string[]; }
interface Facade {
  index(path: string, options?: IndexCoreOptions): Promise<unknown>;
  frames(symbol: string, options?: FramesOptions): Promise<FramesResult>;
  read(path: string, range?: [number, number]): Promise<ReadResult>;
  grep(pattern: string, options?: GrepOptions): Promise<GrepMatch[]>;
  rg(args: string[]): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  list(path?: string): Promise<string[]>;
  retrieve(id: string, range?: [number, number]): Promise<string>;
  sh(command: string): Promise<ShResult>;
}
declare const caco: Facade;
declare function emit(value: unknown): void;`;
