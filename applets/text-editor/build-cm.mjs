import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['applets/text-editor/cm-entry.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'CM',
  outfile: 'applets/text-editor/codemirror-bundle.js',
  target: 'es2020',
});

console.log('✓ Built codemirror-bundle.js');
