import { stat, readFile, glob as fsGlob } from 'fs/promises';
import { execFile } from 'child_process';
import { join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { validatePath } from '../path-utils.js';
import { MAX_FILE_SIZE_BYTES } from '../config.js';
import { type ReadResult, type GrepMatch, type GrepOptions, WorkflowInputError } from './types.js';

const execFileAsync = promisify(execFile);

const RG_MAX_BUFFER = 64 * 1024 * 1024;

function scope(base: string, requested: string): string {
  const v = validatePath(base, requested);
  if (!v.valid) throw new WorkflowInputError(v.error);
  return v.resolved;
}

/**
 * Slice a 1-based inclusive line range out of text. The single clamp used by
 * both file reads and stored-output retrieval. `totalLines` is the number of
 * '\n'-split segments (a newline-terminated file reports N+1; see ReadResult).
 */
export function sliceLinesByRange(
  content: string,
  range?: [start: number, end: number],
): { text: string; range: [number, number]; totalLines: number } {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = range ? Math.max(1, range[0]) : 1;
  const end = range ? Math.min(totalLines, range[1]) : totalLines;
  const text = start > end ? '' : lines.slice(start - 1, end).join('\n');
  return { text, range: [start, end], totalLines };
}

/**
 * Read a 1-based inclusive line range from a file. With no range, returns the
 * whole file. Output is intentionally uncapped (the model-facing bound is the
 * workflow emit/log ceiling, not the individual read); only the file-size guard
 * applies so a workflow can aggregate freely.
 */
export async function readFileRangeCore(
  base: string,
  path: string,
  range?: [start: number, end: number],
): Promise<ReadResult> {
  const resolved = scope(base, path);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new WorkflowInputError(`file not found: ${path}`);
  }
  if (!info.isFile()) throw new WorkflowInputError(`not a file: ${path}`);
  if (info.size > MAX_FILE_SIZE_BYTES) throw new WorkflowInputError(`file too large (${info.size} bytes): ${path}`);

  const content = await readFile(resolved, 'utf8');
  const sliced = sliceLinesByRange(content, range);
  return {
    path: relative(base, resolved) || '.',
    totalLines: sliced.totalLines,
    range: sliced.range,
    text: sliced.text,
  };
}

function sortMatches(matches: GrepMatch[]): GrepMatch[] {
  return matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

interface RgJsonLine {
  type: string;
  data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
}

function stripNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

async function rgGrep(base: string, pattern: string, opts: GrepOptions): Promise<GrepMatch[]> {
  const args = ['--json'];
  if (opts.ignoreCase) args.push('-i');
  if (opts.glob) args.push('--glob', opts.glob);
  args.push('-e', pattern, '--', opts.path ?? '.');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('rg', args, { cwd: base, maxBuffer: RG_MAX_BUFFER }));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 1) return [];
    throw e;
  }
  const matches: GrepMatch[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const evt = JSON.parse(raw) as RgJsonLine;
    if (evt.type !== 'match' || !evt.data) continue;
    const file = evt.data.path?.text;
    const line = evt.data.line_number;
    if (file === undefined || line === undefined) continue;
    const rel = relative(base, resolve(base, file));
    matches.push({ file: rel, line, text: stripNewline(evt.data.lines?.text ?? '') });
  }
  return sortMatches(matches);
}

function globForRgGlob(glob: string | undefined): string {
  if (!glob) return '**/*';
  return glob.includes('/') ? glob : `**/${glob}`;
}

/**
 * Pure-JS grep used only when `rg` is absent. Best-effort parity with rg for the
 * common include case. Unlike rg it does NOT honor .gitignore, skip binary files,
 * or prune .git/node_modules, and it uses JS RegExp (not Rust regex) syntax — so
 * results can differ in a real repo. Exclusion globs (`!*.test.ts`) are not
 * supported here (see globForRgGlob).
 */
async function jsGrep(base: string, pattern: string, opts: GrepOptions): Promise<GrepMatch[]> {
  const root = opts.path ? scope(base, opts.path) : base;
  const flags = opts.ignoreCase ? 'i' : '';
  const re = new RegExp(pattern, flags);
  const matches: GrepMatch[] = [];
  for await (const entry of fsGlob(globForRgGlob(opts.glob), { cwd: root })) {
    const abs = join(root, entry);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_SIZE_BYTES) continue;
    const rel = relative(base, abs);
    if (rel.startsWith('..') || rel.startsWith(sep)) continue;
    const content = await readFile(abs, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === '') continue;
      if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i] });
    }
  }
  return sortMatches(matches);
}

/** Search file contents under `base`. Uses `rg` when present, JS fallback otherwise. */
export async function grepCore(base: string, pattern: string, opts: GrepOptions = {}): Promise<GrepMatch[]> {
  if (opts.path) scope(base, opts.path);
  try {
    return await rgGrep(base, pattern, opts);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return jsGrep(base, pattern, opts);
    throw e;
  }
}

/** Expand a glob under `base`, returning sorted relative paths scoped within `base`. */
export async function globCore(base: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of fsGlob(pattern, { cwd: base })) {
    const abs = join(base, entry);
    const v = validatePath(base, abs);
    if (!v.valid) continue;
    out.push(v.relative);
  }
  return out.sort();
}
