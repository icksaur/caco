export type IndexItem = {
  label: string;
  kind: string;
  startLine: number; // 1-based inclusive, matching view_range.
  endLine: number; // 1-based inclusive, matching view_range.
  children?: IndexItem[];
};

export type IndexSection = {
  name: string;
  items: IndexItem[];
};

export type IndexResult = {
  path: string;
  language: string;
  parser: string;
  totalLines: number;
  sections: IndexSection[];
  diagnostics: string[];
  truncated: boolean;
};

export type IndexOptions = {
  maxEntries: number;
};

export const DEFAULT_MAX_ENTRIES = 200;
export const OUTPUT_CAP_BYTES = 16 * 1024;
export const PARSE_INPUT_CAP_BYTES = 1024 * 1024;

export interface LanguageAdapter {
  /** Resolve a supported language id from a file path, or null if unsupported. */
  detect(path: string): string | null;
  /** Parse source and return a language-neutral skeleton. */
  index(args: { path: string; language: string; source: string; options: IndexOptions }): Promise<IndexResult>;
}
