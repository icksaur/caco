import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { stat, readFile } from 'fs/promises';
import { extname } from 'path';
import { validatePath } from './path-utils.js';
import { MAX_FILE_SIZE_BYTES } from './config.js';
import { treeSitterAdapter } from './index/tree-sitter-adapter.js';
import { formatIndex } from './index/format.js';
import { languageForExtension, LANG_CONFIGS } from './index/extractors.js';
import { DEFAULT_MAX_ENTRIES, PARSE_INPUT_CAP_BYTES } from './index/types.js';

const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  cpp: 'cpp', 'c++': 'cpp', c: 'cpp',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp',
};

const supported = Object.keys(LANG_CONFIGS).join(', ');

function err(message: string) {
  return { textResultForLlm: message };
}

export function createIndexTool(sessionCwd: string) {
  const index = defineTool('index', {
    description: `Produce a compact structural skeleton of ONE source file: its declarations (imports, types, classes, interfaces, functions, methods) each with an exact \`[start-end]\` line range.

Use this BEFORE reading a large/unfamiliar source file: call \`index\` to see the file's shape, then \`view\` only the line ranges you need instead of dumping the whole file. Skip it for small files (just \`view\` them) — it pays off on medium/large files where reading the whole file to find one thing is wasteful.

This parses a single file on demand; it is read-only and does not crawl directories or maintain a repo-wide index. Supported languages: ${supported} (syntactic, not semantic).`,
    parameters: z.object({
      path: z.string().describe('File to index, relative to the session directory or an absolute path inside it.'),
      language: z.string().optional().describe(`Override language detection. One of: ${supported}.`),
      maxEntries: z.number().int().optional().describe(`Max declarations to emit (default ${DEFAULT_MAX_ENTRIES}).`),
    }),
    handler: async ({ path, language, maxEntries }) => {
      const validation = validatePath(sessionCwd, path);
      if (!validation.valid) return err(`Error: ${validation.error}`);
      const resolved = validation.resolved;

      let lang: string | null;
      if (language) {
        lang = LANGUAGE_ALIASES[language.toLowerCase()] ?? null;
        if (!lang) return err(`Error: unsupported language "${language}". Supported: ${supported}.`);
      } else {
        lang = languageForExtension(extname(resolved));
        if (!lang) return err(`Error: unsupported file type "${extname(resolved) || '(none)'}". Supported: ${supported}. Use \`view\` instead.`);
      }

      let info;
      try {
        info = await stat(resolved);
      } catch {
        return err(`Error: file not found: ${validation.relative}`);
      }
      if (!info.isFile()) return err(`Error: not a file: ${validation.relative}`);
      if (info.size > MAX_FILE_SIZE_BYTES) {
        return err(`Error: file too large (${info.size} bytes).`);
      }
      if (info.size > PARSE_INPUT_CAP_BYTES) {
        return err(`File is ${Math.round(info.size / 1024)} KiB, above the ${PARSE_INPUT_CAP_BYTES / 1024} KiB parse cap. Read it in ranges with \`view\` (view_range) instead of indexing.`);
      }

      const source = await readFile(resolved, 'utf8');
      const result = await treeSitterAdapter.index({
        path: validation.relative,
        language: lang,
        source,
        options: { maxEntries: clampEntries(maxEntries) },
      });
      return { textResultForLlm: formatIndex(result) };
    },
  });

  return [index];
}

function clampEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}
