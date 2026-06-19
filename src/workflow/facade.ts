import { readdir } from 'fs/promises';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { indexCore, type IndexCoreOptions } from '../index/core.js';
import { type IndexResult } from '../index/types.js';
import { getOutput } from '../output-store.js';
import { readFileRangeCore, grepCore, globCore, sliceLinesByRange } from './cores.js';
import { type ReadResult, type GrepMatch, type GrepOptions, WorkflowInputError } from './types.js';
import { validatePath } from '../path-utils.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: sessionCwd, maxBuffer: CHILD_MAX_BUFFER });
        return { stdout, stderr, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 };
      }
    },
  };
}

/** Compact, model-facing description of the facade injected into workflow scripts. */
export const FACADE_API_SUMMARY = `A read-oriented facade is available as \`caco\` (all methods are async):
- caco.index(path, { language?, maxEntries? }) -> structural skeleton of one source file (declarations with [start-end] line ranges).
- caco.read(path, [start, end]?) -> { path, totalLines, range, text }. Whole file if range omitted. 1-based inclusive.
- caco.grep(pattern, { path?, glob?, ignoreCase? }) -> [{ file, line, text }]. rg-backed.
- caco.rg(args[]) -> raw rg stdout (escape hatch), scoped to the session dir.
- caco.glob(pattern) -> sorted relative paths.
- caco.list(path?) -> directory entries (dirs suffixed with /).
- caco.retrieve(id, [start, end]?) -> previously stored large tool output by id.
- caco.sh(command) -> { stdout, stderr, code }. Runs a shell command in the session dir; never throws on non-zero exit.
All paths are scoped to the session directory; escaping it throws — except \`rg\` and \`sh\`, which are unrestricted escape hatches that run host tooling. Use emit(value) to return your compact result.`;

/** Hand-authored .d.ts injected so workflow scripts get types for \`caco\`. */
export const FACADE_DTS = `interface ReadResult { path: string; totalLines: number; range: [number, number]; text: string; }
interface GrepMatch { file: string; line: number; text: string; }
interface GrepOptions { path?: string; glob?: string; ignoreCase?: boolean; }
interface IndexCoreOptions { language?: string; maxEntries?: number; }
interface ShResult { stdout: string; stderr: string; code: number; }
interface Facade {
  index(path: string, options?: IndexCoreOptions): Promise<unknown>;
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
