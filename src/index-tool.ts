import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { formatIndex } from './index/format.js';
import { indexCore, IndexInputError, SUPPORTED_LANGUAGES } from './index/core.js';
import { DEFAULT_MAX_ENTRIES } from './index/types.js';

function err(message: string) {
  return { textResultForLlm: message };
}

export function createIndexTool(sessionCwd: string) {
  const index = defineTool('index', {
    description: `Produce a compact structural skeleton of ONE source file: its declarations (imports, types, classes, interfaces, functions, methods) each with an exact \`[start-end]\` line range.

Use this BEFORE reading a large/unfamiliar source file: call \`index\` to see the file's shape, then \`view\` only the line ranges you need instead of dumping the whole file. Skip it for small files (just \`view\` them) — it pays off on medium/large files where reading the whole file to find one thing is wasteful.

This parses a single file on demand; it is read-only and does not crawl directories or maintain a repo-wide index. Supported languages: ${SUPPORTED_LANGUAGES} (syntactic, not semantic).`,
    parameters: z.object({
      path: z.string().describe('File to index, relative to the session directory or an absolute path inside it.'),
      language: z.string().optional().describe(`Override language detection. One of: ${SUPPORTED_LANGUAGES}.`),
      maxEntries: z.number().int().optional().describe(`Max declarations to emit (default ${DEFAULT_MAX_ENTRIES}).`),
    }),
    handler: async ({ path, language, maxEntries }) => {
      try {
        const result = await indexCore(sessionCwd, path, { language, maxEntries });
        return { textResultForLlm: formatIndex(result) };
      } catch (e) {
        if (e instanceof IndexInputError) return err(e.message);
        throw e;
      }
    },
  });

  return [index];
}
