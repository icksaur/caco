import { stat, readFile } from 'fs/promises';
import { extname } from 'path';
import { validatePath, resolveReadPath, toPosix } from '../path-utils.js';
import { MAX_FILE_SIZE_BYTES } from '../config.js';
import { treeSitterAdapter } from './tree-sitter-adapter.js';
import { languageForExtension, LANG_CONFIGS } from './extractors.js';
import { DEFAULT_MAX_ENTRIES, PARSE_INPUT_CAP_BYTES, type IndexResult } from './types.js';

const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  cpp: 'cpp', 'c++': 'cpp', c: 'cpp',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp',
};

export const SUPPORTED_LANGUAGES = Object.keys(LANG_CONFIGS).join(', ');

/** Bad input the caller should surface verbatim (path/type/size), not a crash. */
export class IndexInputError extends Error {}

function clampEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

export interface IndexCoreOptions {
  language?: string;
  maxEntries?: number;
  /**
   * Bash-parity reach for the workflow facade's `caco.index`: resolve relative
   * paths against `sessionCwd` but allow absolute/`..` paths (see
   * docs/spec-caco-run-workflow Part 2b). The standalone top-level `index` tool
   * leaves this false, keeping its `sessionCwd` scope.
   */
  external?: boolean;
}

/**
 * Resolve, validate, and parse one source file into a language-neutral skeleton.
 * The single source of truth behind both the `index` tool (which formats the
 * result) and the workflow facade (which returns it as data). Throws
 * IndexInputError for caller-surfaceable problems.
 */
export async function indexCore(
  sessionCwd: string,
  path: string,
  options: IndexCoreOptions = {},
): Promise<IndexResult> {
  let resolved: string;
  let display: string;
  if (options.external) {
    ({ resolved, display } = resolveReadPath(sessionCwd, path));
  } else {
    const validation = validatePath(sessionCwd, path);
    if (!validation.valid) throw new IndexInputError(`Error: ${validation.error}`);
    resolved = validation.resolved;
    display = toPosix(validation.relative);
  }

  let lang: string | null;
  if (options.language) {
    lang = LANGUAGE_ALIASES[options.language.toLowerCase()] ?? null;
    if (!lang) throw new IndexInputError(`Error: unsupported language "${options.language}". Supported: ${SUPPORTED_LANGUAGES}.`);
  } else {
    lang = languageForExtension(extname(resolved));
    if (!lang) throw new IndexInputError(`Error: unsupported file type "${extname(resolved) || '(none)'}". Supported: ${SUPPORTED_LANGUAGES}. Use \`view\` instead.`);
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new IndexInputError(`Error: file not found: ${display}`);
  }
  if (!info.isFile()) throw new IndexInputError(`Error: not a file: ${display}`);
  if (info.size > MAX_FILE_SIZE_BYTES) throw new IndexInputError(`Error: file too large (${info.size} bytes).`);
  if (info.size > PARSE_INPUT_CAP_BYTES) {
    throw new IndexInputError(`File is ${Math.round(info.size / 1024)} KiB, above the ${PARSE_INPUT_CAP_BYTES / 1024} KiB parse cap. Read it in ranges with \`view\` (view_range) instead of indexing.`);
  }

  const source = await readFile(resolved, 'utf8');
  return treeSitterAdapter.index({
    path: display,
    language: lang,
    source,
    options: { maxEntries: clampEntries(options.maxEntries) },
  });
}
