/**
 * Server Configuration
 */

const DEFAULT_PORT = 3000;

export const PORT = parseInt(
  process.env.CACO_PORT || process.env.PORT || String(DEFAULT_PORT),
  10
);

export const SERVER_URL = process.env.CACO_SERVER_URL || `http://localhost:${PORT}`;

// Timeouts (milliseconds)
export const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
export const SCHEDULE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const SCHEDULE_BUSY_DELAY_MS = 60 * 60 * 1000;
export const RESTARTER_POLL_MS = 500;
export const RESTARTER_TIMEOUT_MS = 30 * 1000;

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

