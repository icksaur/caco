/**
 * Server Configuration
 */

const DEFAULT_PORT = 53000;
const DEFAULT_HOST = '127.0.0.1';

export const PORT = parseInt(
  process.env.CACO_PORT || process.env.PORT || String(DEFAULT_PORT),
  10
);

export const HOST = process.env.CACO_HOST || DEFAULT_HOST;

export const SERVER_URL = process.env.CACO_SERVER_URL || `http://localhost:${PORT}`;

// Timeouts (milliseconds)
export const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
export const SCHEDULE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const SCHEDULE_BUSY_DELAY_MS = 60 * 60 * 1000;

// Cache TTLs (milliseconds)
export const OUTPUT_CACHE_TTL_MS = 30 * 60 * 1000;
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Limits
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const EXEC_TIMEOUT_MS = 60 * 1000;
export const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Agent runaway guard
export const AGENT_MAX_DEPTH = 2;
export const AGENT_MAX_AGE_SECONDS = 60 * 60;
export const AGENT_RATE_LIMIT_CALLS = 10;
export const AGENT_RATE_LIMIT_WINDOW_SECONDS = 60;

// Extension→MIME mapping (single source of truth for file types)
export const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  // Text
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  json: 'application/json',
  xml: 'application/xml',
  // Code
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  sh: 'text/x-shellscript',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  // Documents
  pdf: 'application/pdf',
};

