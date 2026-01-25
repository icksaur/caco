/**
 * Display Output Cache
 * 
 * Stores large outputs (files, terminal output, images) for display
 * without sending through LLM context. Content is cached in-memory
 * with automatic TTL cleanup.
 */

const displayOutputs = new Map();
const OUTPUT_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Store content in cache with metadata
 * @param {string|Buffer} data - Content to store
 * @param {Object} metadata - Type info, path, etc.
 * @returns {string} Output ID for retrieval
 */
export function storeOutput(data, metadata = {}) {
  const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  displayOutputs.set(id, {
    data,
    metadata,
    createdAt: Date.now()
  });
  
  // Auto-cleanup after TTL
  setTimeout(() => displayOutputs.delete(id), OUTPUT_TTL);
  
  return id;
}

/**
 * Retrieve output from cache
 * @param {string} id - Output ID
 * @returns {Object|undefined} { data, metadata, createdAt }
 */
export function getOutput(id) {
  return displayOutputs.get(id);
}

/**
 * Detect programming language from file extension
 * @param {string} filepath - Path to file
 * @returns {string} Language identifier for syntax highlighting
 */
export function detectLanguage(filepath) {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const langMap = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    lua: 'lua',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml',
    html: 'html', htm: 'html',
    css: 'css',
    scss: 'scss', sass: 'scss',
    md: 'markdown',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    env: 'shell'
  };
  return langMap[ext] || 'plaintext';
}
