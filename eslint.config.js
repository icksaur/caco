import globals from 'globals';
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      // Dead code detection
      'no-unused-vars': ['warn', { 
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'caughtErrorsIgnorePattern': '^_'
      }],
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      
      // Code quality
      'no-console': 'off', // Allow console for server logs
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['warn', 'always'],
      
      // Style (minimal)
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { 'avoidEscape': true }]
    }
  },
  {
    // Browser-only files
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Libraries loaded via script tags
        marked: 'readonly',
        DOMPurify: 'readonly',
        hljs: 'readonly',
        mermaid: 'readonly',
        // Our own scripts loaded separately
        renderMarkdown: 'readonly'
      }
    },
    rules: {
      // Allow functions used by inline HTML onclick handlers
      'no-unused-vars': ['warn', { 
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^(toggleActivityBox|toggleNewChatForm|createNewSession|_)'
      }]
    }
  },
  {
    ignores: [
      'node_modules/**',
      'public/*.min.js',  // Ignore minified vendor libraries
      'public/bundle.js'  // Ignore bundled output
    ]
  }
];
