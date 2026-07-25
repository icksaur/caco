import { stat, readFile, glob as fsGlob } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { validatePath, resolveReadPath, toPosix } from '../path-utils.js';
import { MAX_FILE_SIZE_BYTES } from '../config.js';
import { type ReadResult, type GrepMatch, type GrepOptions, type ReadSpec, type PeekResult, WorkflowInputError } from './types.js';

const execFileAsync = promisify(execFile);

const RG_MAX_BUFFER = 64 * 1024 * 1024;

const require = createRequire(import.meta.url);

/**
 * Resolve the vendored ripgrep binary (@vscode/ripgrep) by resolving its
 * per-platform optional dependency's binary directly, rather than importing the
 * package (whose ESM entry throws if the platform optional dep is missing). The
 * resolved path is immutable for the process, so it is cached; existence is still
 * checked per call in resolveRg(). Returns null when the platform binary is absent
 * (then callers fall back to jsGrep).
 */
let cachedVendoredRg: string | null | undefined;
function vendoredRgPath(): string | null {
  if (cachedVendoredRg === undefined) {
    const arch = process.env.npm_config_arch || process.arch;
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
    try {
      cachedVendoredRg = require.resolve(`${platformPkg}/bin/${binaryName}`);
    } catch {
      cachedVendoredRg = null;
    }
  }
  return cachedVendoredRg;
}

/**
 * Resolve a usable ripgrep binary path, or null if none is available.
 * Precedence: CACO_RG_PATH (explicit override) -> vendored @vscode/ripgrep ->
 * null. No PATH scavenging (vendoring removes the need and avoids system-rg
 * --json version skew). The override is re-checked every call so a runtime
 * CACO_RG_PATH change takes effect; only the vendored *location* lookup is cached.
 */
export function resolveRg(): string | null {
  const override = process.env.CACO_RG_PATH;
  if (override && existsSync(override)) return override;
  const vendored = vendoredRgPath();
  if (vendored && existsSync(vendored)) return vendored;
  return null;
}

function scope(base: string, requested: string): string {
  const v = validatePath(base, requested);
  if (!v.valid) throw new WorkflowInputError(v.error);
  return v.resolved;
}

/**
 * Resolve a facade read input to an absolute target + a display path. `external`
 * (the workflow addressed reads: read/reads/peek/list/index) allows ANY path via
 * resolveReadPath — bash parity with sh/rg (see docs/spec-caco-run-workflow Part
 * 2b). Otherwise the path is hard-scoped to `base` via validatePath (the default,
 * so a shared-core caller like frames stays scoped and its result paths stay
 * base-relative unless it explicitly opts in). Empty path is a caller error in
 * both modes.
 */
function resolveInput(base: string, requested: string, external: boolean): { resolved: string; display: string } {
  if (!requested) throw new WorkflowInputError('path is required');
  if (external) {
    const { resolved, display } = resolveReadPath(base, requested);
    return { resolved, display };
  }
  const v = validatePath(base, requested);
  if (!v.valid) throw new WorkflowInputError(v.error);
  return { resolved: v.resolved, display: toPosix(v.relative) };
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
  external = false,
): Promise<ReadResult> {
  const { resolved, display } = resolveInput(base, path, external);
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
    path: display,
    totalLines: sliced.totalLines,
    range: sliced.range,
    text: sliced.text,
  };
}

/**
 * For each literal anchor, return the surrounding ±context lines around its first
 * occurrence in the file, with the exact text — the gather step for batching many
 * edits: each result's `text` is a precise `old_str` candidate without re-viewing.
 * Anchors are plain substrings (not regex); a missing anchor yields `found: false`
 * rather than throwing, so one bad anchor doesn't lose the rest of the batch.
 */
export async function peekAnchorsCore(
  base: string,
  path: string,
  anchors: string[],
  context = 3,
  external = false,
): Promise<PeekResult[]> {
  const resolved = resolveInput(base, path, external).resolved;
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new WorkflowInputError(`file not found: ${path}`);
  }
  if (!info.isFile()) throw new WorkflowInputError(`not a file: ${path}`);
  if (info.size > MAX_FILE_SIZE_BYTES) throw new WorkflowInputError(`file too large (${info.size} bytes): ${path}`);
  const ctx = Math.max(0, Math.floor(context));
  const lines = (await readFile(resolved, 'utf8')).split('\n');
  return anchors.map((anchor) => {
    const idx = lines.findIndex((l) => l.includes(anchor));
    if (idx === -1) return { anchor, found: false };
    const line = idx + 1;
    const start = Math.max(1, line - ctx);
    const end = Math.min(lines.length, line + ctx);
    return { anchor, found: true, line, range: [start, end] as [number, number], text: lines.slice(start - 1, end).join('\n') };
  });
}

/**
 * Batch-read many ranges in input order, reading each unique file exactly once
 * (keyed by resolved path) so multiple ranges within one file don't re-stat/re-read
 * it. Fail-fast: a missing/non-file/oversized path throws WorkflowInputError for the
 * whole batch — `reads` is a commit-to-edit gather, so a bad path means a wrong mental
 * model the caller should fix and re-run (contrast peekAnchorsCore, which tolerates
 * misses). Out-of-bounds ranges are clamped, not errors (see sliceLinesByRange).
 */
export async function readSpecsCore(base: string, specs: ReadSpec[], external = false): Promise<ReadResult[]> {
  const cache = new Map<string, { rel: string; content: string }>();
  const results: ReadResult[] = [];
  for (const spec of specs) {
    const { resolved, display } = resolveInput(base, spec.path, external);
    let entry = cache.get(resolved);
    if (!entry) {
      let info;
      try {
        info = await stat(resolved);
      } catch {
        throw new WorkflowInputError(`file not found: ${spec.path}`);
      }
      if (!info.isFile()) throw new WorkflowInputError(`not a file: ${spec.path}`);
      if (info.size > MAX_FILE_SIZE_BYTES) throw new WorkflowInputError(`file too large (${info.size} bytes): ${spec.path}`);
      entry = { rel: display, content: await readFile(resolved, 'utf8') };
      cache.set(resolved, entry);
    }
    const sliced = sliceLinesByRange(entry.content, spec.range);
    results.push({ path: entry.rel, totalLines: sliced.totalLines, range: sliced.range, text: sliced.text });
  }
  return results;
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

async function rgGrep(rgPath: string, base: string, pattern: string, opts: GrepOptions): Promise<GrepMatch[]> {
  const args = ['--json'];
  if (opts.ignoreCase) args.push('-i');
  if (opts.glob) args.push('--glob', opts.glob);
  args.push('-e', pattern, '--', opts.path ?? '.');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(rgPath, args, { cwd: base, maxBuffer: RG_MAX_BUFFER, windowsHide: true }));
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
    const rel = toPosix(relative(base, resolve(base, file)));
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
    const posixRel = toPosix(rel);
    const content = await readFile(abs, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === '') continue;
      if (re.test(lines[i])) matches.push({ file: posixRel, line: i + 1, text: lines[i] });
    }
  }
  return sortMatches(matches);
}

/**
 * Search file contents under `base`. Uses ripgrep when available (resolveRg:
 * CACO_RG_PATH -> vendored @vscode/ripgrep), else a pure-JS fallback. The `rg`
 * param is an injectable seam (default resolveRg()); pass `null` to force the JS
 * fallback deterministically in tests. A stale vendored path that fails to spawn
 * (ENOENT) also falls back.
 */
export async function grepCore(
  base: string,
  pattern: string,
  opts: GrepOptions = {},
  rg: string | null = resolveRg(),
): Promise<GrepMatch[]> {
  if (opts.path) scope(base, opts.path);
  if (!rg) return jsGrep(base, pattern, opts);
  try {
    return await rgGrep(rg, base, pattern, opts);
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
    out.push(toPosix(v.relative));
  }
  return out.sort();
}
