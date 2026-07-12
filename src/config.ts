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
export const AGENT_MAX_DEPTH = 3;
export const AGENT_MAX_AGE_SECONDS = 60 * 60;
export const AGENT_RATE_LIMIT_CALLS = 10;
export const AGENT_RATE_LIMIT_WINDOW_SECONDS = 60;

// caco_run_workflow (code-execution orchestration). On by default: it runs
// arbitrary code auto-approved, but only ever the read-oriented `caco` facade
// inside a bounded child process. Opt out with CACO_WORKFLOW=0.
export const WORKFLOW_ENABLED = process.env.CACO_WORKFLOW !== '0';
export const WORKFLOW_TIMEOUT_DEFAULT_MS = 30 * 1000;
// Real hard cap. Advertised as 120s in the tool description (WORKFLOW_TIMEOUT_ADVERTISED_MS)
// with ~10s wiggle room so commands near the advertised limit still complete.
export const WORKFLOW_TIMEOUT_CAP_MS = 130 * 1000;
export const WORKFLOW_TIMEOUT_ADVERTISED_MS = 120 * 1000;
export const WORKFLOW_KILL_GRACE_MS = 2 * 1000;
export const WORKFLOW_LOG_CAP_BYTES = 256 * 1024;
export const WORKFLOW_EMIT_CAP_BYTES = 16 * 1024;
// Hard ceiling on the result envelope the runner will read into memory, so a
// runaway emit() (e.g. a 1 GB string) can never exhaust the Caco process.
export const WORKFLOW_RESULT_MAX_BYTES = 2 * 1024 * 1024;

// Workflow savings model (see docs/spec-workflow-savings-model.md). Tunables.
// Rough output tokens one tool-call arg block would have cost the model.
export const WORKFLOW_AVG_TOOLCALL_TOKENS = 40;
// Fallback per-round-trip latency before any request has completed (ms).
export const WORKFLOW_AVG_ROUNDTRIP_MS = 8000;
// Sanity cap so one pathological fan-out cannot dominate the headline.
export const WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN = 1000;
// Round trips before batchFactor (tool calls/turn) is trusted; below it, full credit.
export const BATCH_WARMUP_TURNS = 3;

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
  // Audio (browser-native playback in the files applet's audio viewer)
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

