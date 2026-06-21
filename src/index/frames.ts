import { indexCore } from './core.js';
import { type IndexItem, type IndexSection } from './types.js';
import { grepCore, readFileRangeCore } from '../workflow/cores.js';
import { type GrepMatch } from '../workflow/types.js';

export type FrameKind = 'definition' | 'incoming';
export type Confidence = 'exact' | 'heuristic';

export interface Frame {
  kind: FrameKind;
  /** POSIX-style ('/'-separated) path relative to the session directory. */
  file: string;
  /** 1-based line of the site (definition start, or caller line). */
  line: number;
  /** Code snippet around the site (CRLF-normalized to '\n'). */
  code: string;
  confidence: Confidence;
}

export interface FramesOptions {
  /** rg-style include glob; defaults to source files by extension (never the whole tree). */
  glob?: string;
  /** Disambiguate when a symbol is defined in many files (POSIX or '\\' path; suffix match). */
  file?: string;
  /** v1: 'definition' and/or 'incoming'. Default both. ('outgoing' is v2.) */
  include?: FrameKind[];
  /** Lines of context around each site (default 6). */
  context?: number;
  /** Cap on total returned frames (default 20). */
  maxFrames?: number;
  /** Cap on candidate files indexed for definitions (default 200). */
  maxFiles?: number;
  /** Cap on grep hits considered (default 500). */
  maxHits?: number;
}

export interface FramesResult {
  symbol: string;
  definitions: Frame[];
  incoming: Frame[];
  /** Any cap (frames/files/hits) or per-file index truncation was hit. */
  truncated: boolean;
  notes: string[];
}

const DEFAULT_CONTEXT = 6;
const DEFAULT_MAX_FRAMES = 20;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_HITS = 500;
const LOOKUP_MAX_ENTRIES = 5000;
const MAX_DEF_LINES = 60;

const SOURCE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
  'cs',
  'glsl', 'vert', 'frag', 'comp', 'geom', 'tesc', 'tese', 'hlsl',
];
const DEFAULT_GLOB = `**/*.{${SOURCE_EXTS.join(',')}}`;

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', 'vendor', 'third_party', 'coverage', '.cache',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Emit paths with '/' separators regardless of platform. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function normalizeQual(s: string): string {
  return s.replace(/::/g, '.');
}

function isExcluded(posixPath: string): boolean {
  return posixPath.split('/').some((seg) => EXCLUDED_DIRS.has(seg));
}

/** Split file text on '\n' (grep/tree-sitter line parity) and strip a trailing '\r' per line. */
function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function buildSnippet(lines: string[], start: number, end: number): string {
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  if (s > e) return '';
  return lines.slice(s - 1, e).join('\n');
}

interface DeclCandidate {
  name: string;
  qualified: string;
  kind: string;
  startLine: number;
  endLine: number;
}

function declHead(label: string): string {
  const p = label.indexOf('(');
  return (p >= 0 ? label.slice(0, p) : label).trim();
}

function lastSegment(head: string): string {
  const parts = head.split(/::|\./);
  return parts[parts.length - 1] || head;
}

function collectDecls(sections: IndexSection[]): DeclCandidate[] {
  const out: DeclCandidate[] = [];
  const visit = (item: IndexItem, sectionName: string, parentQual: string): void => {
    if (sectionName === 'imports' || item.kind === 'import' || item.kind === 'test') {
      for (const child of item.children ?? []) visit(child, sectionName, parentQual);
      return;
    }
    const head = declHead(item.label);
    const simple = lastSegment(head);
    const qualified = parentQual ? `${parentQual}.${simple}` : normalizeQual(head);
    out.push({ name: simple, qualified, kind: item.kind, startLine: item.startLine, endLine: item.endLine });
    for (const child of item.children ?? []) visit(child, sectionName, qualified);
  };
  for (const section of sections) {
    for (const item of section.items) visit(item, section.name, '');
  }
  return out;
}

function declMatches(cand: DeclCandidate, symbol: string): boolean {
  if (/::|\./.test(symbol)) {
    const symNorm = normalizeQual(symbol);
    return cand.qualified === symNorm || cand.qualified.endsWith(`.${symNorm}`) || cand.qualified.endsWith(symNorm);
  }
  return cand.name === symbol;
}

function regexDefPatterns(symbol: string): RegExp[] {
  const s = escapeRegex(symbol);
  return [
    new RegExp(`\\b(?:struct|class|enum|interface|union)\\s+${s}\\b`),
    new RegExp(`\\b(?:uniform|buffer)\\s+${s}\\b`),
    new RegExp(`\\b(?:uniform|buffer|in|out|attribute|varying)\\s+\\w+\\s+${s}\\b`),
    new RegExp(`#define\\s+${s}\\b`),
    new RegExp(`\\b${s}\\s*\\([^;{]*\\)[^;{]*\\{`),
    new RegExp(`^[\\w:<>\\*&,\\s]+\\b${s}\\s*\\([^;{]*$`),
  ];
}

interface FileText {
  posix: string;
  lines: string[];
}

function isImportLine(line: string): boolean {
  const t = line.trim();
  return (
    /^import\b/.test(t) ||
    /^#\s*include\b/.test(t) ||
    /^using\b/.test(t) ||
    /\bfrom\b.*['"]/.test(t) && /^(import|export)\b/.test(t) ||
    /^(?:const|let|var)\s+.*\brequire\s*\(/.test(t)
  );
}

/** Lines that are line-comments or interior to a block comment (best-effort). */
function commentLineSet(lines: string[]): Set<number> {
  const set = new Set<number>();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (inBlock) {
      set.add(i + 1);
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) set.add(i + 1);
    const open = line.lastIndexOf('/*');
    if (open >= 0) {
      const close = line.indexOf('*/', open);
      if (close < 0) inBlock = true;
    }
  }
  return set;
}

/** Best-effort: is character index `idx` inside a string literal on this line? */
function isInString(line: string, idx: number): boolean {
  let single = false;
  let dbl = false;
  let tick = false;
  for (let i = 0; i < idx && i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" && !dbl && !tick) single = !single;
    else if (c === '"' && !single && !tick) dbl = !dbl;
    else if (c === '`' && !single && !dbl) tick = !tick;
  }
  return single || dbl || tick;
}

function classifyIncoming(line: string, symbol: string): Confidence {
  const callRe = new RegExp(`\\b${escapeRegex(symbol)}\\s*\\(`);
  const m = callRe.exec(line);
  if (m && !isInString(line, m.index)) return 'exact';
  return 'heuristic';
}

async function readFileText(cwd: string, posixPath: string): Promise<FileText | null> {
  try {
    const res = await readFileRangeCore(cwd, posixPath);
    return { posix: toPosix(res.path), lines: splitLines(res.text) };
  } catch {
    return null;
  }
}

export interface BuildFramesDeps {
  grep: (pattern: string, glob: string) => Promise<GrepMatch[]>;
  index: (path: string) => Promise<IndexSection[] | null>;
}

function defaultDeps(cwd: string): BuildFramesDeps {
  return {
    grep: (pattern, glob) => grepCore(cwd, pattern, { glob }),
    index: async (path) => {
      try {
        const res = await indexCore(cwd, path, { maxEntries: LOOKUP_MAX_ENTRIES });
        return res.truncated ? null : res.sections;
      } catch {
        return null;
      }
    },
  };
}

export async function buildFrames(
  cwd: string,
  symbol: string,
  opts: FramesOptions = {},
  deps?: BuildFramesDeps,
): Promise<FramesResult> {
  const d = deps ?? defaultDeps(cwd);
  const include = opts.include ?? ['definition', 'incoming'];
  const context = opts.context ?? DEFAULT_CONTEXT;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  const glob = toPosix(opts.glob ?? DEFAULT_GLOB);
  const fileFilter = opts.file ? toPosix(opts.file) : null;

  const notes: string[] = [];
  let truncated = false;

  const simple = lastSegment(symbol);
  const allHits = await d.grep(`\\b${escapeRegex(simple)}\\b`, glob);
  const hits = allHits
    .map((h) => ({ ...h, file: toPosix(h.file) }))
    .filter((h) => !isExcluded(h.file));

  const consideredHits = hits.slice(0, maxHits);
  if (hits.length > maxHits) {
    truncated = true;
    notes.push(`grep hits capped at ${maxHits} (had ${hits.length})`);
  }

  const fileCache = new Map<string, FileText | null>();
  const getFile = async (posixPath: string): Promise<FileText | null> => {
    if (fileCache.has(posixPath)) return fileCache.get(posixPath) ?? null;
    const ft = await readFileText(cwd, posixPath);
    fileCache.set(posixPath, ft);
    return ft;
  };

  const definitions: Frame[] = [];
  const defRanges = new Map<string, Array<[number, number]>>();
  const addDefRange = (file: string, start: number, end: number): void => {
    const list = defRanges.get(file) ?? [];
    list.push([start, end]);
    defRanges.set(file, list);
  };

  const wantDefs = include.includes('definition');

  {
    const seenFiles = new Set<string>();
    const candidateFiles: string[] = [];
    for (const h of consideredHits) {
      const key = h.file.toLowerCase();
      if (seenFiles.has(key)) continue;
      if (fileFilter && !h.file.endsWith(fileFilter)) continue;
      seenFiles.add(key);
      if (candidateFiles.length >= maxFiles) {
        truncated = true;
        notes.push(`candidate files capped at ${maxFiles}`);
        break;
      }
      candidateFiles.push(h.file);
    }

    for (const file of candidateFiles) {
      const ft = await getFile(file);
      if (!ft) continue;
      const sections = await d.index(file);
      let matched = false;
      if (sections) {
        for (const cand of collectDecls(sections)) {
          if (!declMatches(cand, symbol)) continue;
          matched = true;
          const end = Math.min(cand.endLine, cand.startLine + MAX_DEF_LINES - 1);
          definitions.push({
            kind: 'definition',
            file,
            line: cand.startLine,
            code: buildSnippet(ft.lines, cand.startLine, end),
            confidence: 'exact',
          });
          addDefRange(file, cand.startLine, cand.endLine);
        }
      }
      if (!matched) {
        const patterns = regexDefPatterns(symbol);
        for (let i = 0; i < ft.lines.length; i++) {
          const line = ft.lines[i];
          if (!patterns.some((re) => re.test(line))) continue;
          if (!new RegExp(`\\b${escapeRegex(simple)}\\b`).test(line)) continue;
          const ln = i + 1;
          definitions.push({
            kind: 'definition',
            file,
            line: ln,
            code: buildSnippet(ft.lines, ln - context, ln + context),
            confidence: 'heuristic',
          });
          addDefRange(file, ln, ln);
          if (wantDefs) notes.push(`regex-tier definition (no grammar/truncated): ${file}:${ln}`);
        }
      }
    }
  }

  const incoming: Frame[] = [];
  if (include.includes('incoming')) {
    const commentCache = new Map<string, Set<number>>();
    for (const h of consideredHits) {
      const ft = await getFile(h.file);
      if (!ft) continue;
      const ranges = defRanges.get(h.file) ?? [];
      if (ranges.some(([s, e]) => h.line >= s && h.line <= e)) continue;
      const line = ft.lines[h.line - 1] ?? h.text;
      if (isImportLine(line)) continue;
      let comments = commentCache.get(h.file);
      if (!comments) {
        comments = commentLineSet(ft.lines);
        commentCache.set(h.file, comments);
      }
      if (comments.has(h.line)) continue;
      incoming.push({
        kind: 'incoming',
        file: h.file,
        line: h.line,
        code: buildSnippet(ft.lines, h.line - context, h.line + context),
        confidence: classifyIncoming(line, simple),
      });
    }
    incoming.sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === 'exact' ? -1 : 1;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
    });
  }

  const allDefs = wantDefs ? definitions : [];
  const total = allDefs.length + incoming.length;
  let cappedDefs = allDefs;
  let cappedIncoming = incoming;
  if (allDefs.length >= maxFrames) {
    cappedDefs = allDefs.slice(0, maxFrames);
    cappedIncoming = [];
  } else {
    cappedIncoming = incoming.slice(0, maxFrames - allDefs.length);
  }
  if (cappedDefs.length + cappedIncoming.length < total) {
    truncated = true;
    notes.push(`frames capped at ${maxFrames}`);
  }

  return { symbol, definitions: cappedDefs, incoming: cappedIncoming, truncated, notes };
}
