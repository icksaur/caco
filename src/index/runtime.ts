import { createRequire } from 'module';
import { join, dirname } from 'path';
import { Parser, Language, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'cpp' | 'c_sharp';

const GRAMMAR_WASM: Record<GrammarId, { pkg: string; file: string }> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  cpp: { pkg: 'tree-sitter-cpp', file: 'tree-sitter-cpp.wasm' },
  c_sharp: { pkg: 'tree-sitter-c-sharp', file: 'tree-sitter-c_sharp.wasm' },
};

function resolveWasm(grammar: GrammarId): string {
  const { pkg, file } = GRAMMAR_WASM[grammar];
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return join(dirname(pkgJson), file);
}

/**
 * Owns the tree-sitter runtime and grammar cache. Init and per-grammar loads
 * are single-flight (memoized promises); a grammar that fails to load caches
 * its rejection so it is never retried and never crashes other languages.
 *
 * The loader/initializer are injectable so tests can assert single-flight
 * behavior and simulate load failures without touching the wasm runtime.
 */
export class TreeSitterRuntime {
  private initPromise: Promise<void> | null = null;
  private readonly languages = new Map<GrammarId, Promise<Language>>();

  constructor(
    private readonly initParser: () => Promise<void> = () => Parser.init(),
    private readonly loadLanguage: (wasmPath: string) => Promise<Language> = (p) => Language.load(p),
  ) {}

  private init(): Promise<void> {
    return (this.initPromise ??= this.initParser());
  }

  getLanguage(grammar: GrammarId): Promise<Language> {
    let pending = this.languages.get(grammar);
    if (!pending) {
      pending = this.loadOne(grammar);
      this.languages.set(grammar, pending);
    }
    return pending;
  }

  private async loadOne(grammar: GrammarId): Promise<Language> {
    await this.init();
    return this.loadLanguage(resolveWasm(grammar));
  }

  /**
   * Parse `source`, hand the root node to `extract`, then delete the tree and
   * parser. No tree is retained past extraction (no incremental reuse in V1).
   */
  async withTree<T>(grammar: GrammarId, source: string, extract: (root: Node) => T): Promise<T> {
    const language = await this.getLanguage(grammar);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source);
      if (!tree) throw new Error(`tree-sitter returned no tree for grammar ${grammar}`);
      try {
        return extract(tree.rootNode);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }
}

export const runtime = new TreeSitterRuntime();
