#!/usr/bin/env node

/**
 * Build a minified, language-restricted highlight.js bundle to
 * public/highlight.min.js. Replaces the kitchen-sink CDN build with
 * only the languages we actually use in chat fenced code blocks.
 *
 * Usage: node scripts/build-highlight.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const LANGUAGES = [
  'bash',
  'cpp',
  'csharp',
  'css',
  'glsl',
  'javascript',
  'json',
  'markdown',
  'powershell',
  'python',
  'sql',
  'typescript',
  'xml',
  'yaml',
];

const entryContents = `
import hljs from 'highlight.js/lib/core';
${LANGUAGES.map((l) => `import ${l} from 'highlight.js/lib/languages/${l}';`).join('\n')}

${LANGUAGES.map((l) => `hljs.registerLanguage(${JSON.stringify(l)}, ${l});`).join('\n')}

hljs.registerAliases(['html', 'htm'], { languageName: 'xml' });

globalThis.hljs = hljs;
`;

await build({
  stdin: {
    contents: entryContents,
    resolveDir: projectRoot,
    sourcefile: 'highlight-entry.js',
  },
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: join(projectRoot, 'public', 'highlight.min.js'),
  logLevel: 'info',
});

const out = join(projectRoot, 'public', 'highlight.min.js');
const bytes = readFileSync(out).length;
console.log(`✓ wrote ${out} (${bytes.toLocaleString()} bytes, ${LANGUAGES.length} languages)`);
