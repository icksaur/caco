import { extname } from 'path';
import { type IndexResult, type IndexOptions, type LanguageAdapter } from './types.js';
import { runtime, TreeSitterRuntime } from './runtime.js';
import { LANG_CONFIGS, languageForExtension, extractSections } from './extractors.js';

const PARSER_NAME = 'tree-sitter';

export class TreeSitterAdapter implements LanguageAdapter {
  constructor(private readonly rt: TreeSitterRuntime = runtime) {}

  detect(path: string): string | null {
    return languageForExtension(extname(path));
  }

  async index(args: { path: string; language: string; source: string; options: IndexOptions }): Promise<IndexResult> {
    const { path, language, source, options } = args;
    const config = LANG_CONFIGS[language];
    if (!config) {
      return emptyResult(path, language, source, [`Unsupported language: ${language}`]);
    }

    const totalLines = countLines(source);
    try {
      const { sections, truncated } = await this.rt.withTree(config.grammar, source, (root) =>
        extractSections(root, config, options),
      );
      const diagnostics: string[] = [];
      if (truncated) diagnostics.push(`Output truncated at maxEntries=${options.maxEntries}.`);
      return { path, language, parser: PARSER_NAME, totalLines, sections, diagnostics, truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return emptyResult(path, language, source, [`Parse failed: ${message}`]);
    }
  }
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

function emptyResult(path: string, language: string, source: string, diagnostics: string[]): IndexResult {
  return {
    path, language, parser: PARSER_NAME,
    totalLines: countLines(source),
    sections: [], diagnostics, truncated: false,
  };
}

export const treeSitterAdapter = new TreeSitterAdapter();
