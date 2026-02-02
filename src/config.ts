/**
 * Server Configuration
 * 
 * Centralized configuration for all server constants.
 * Environment variables override defaults.
 */

// ─────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

/**
 * Server port - from environment or default
 */
export const PORT = parseInt(
  process.env.CACO_PORT || process.env.PORT || String(DEFAULT_PORT),
  10
);

/**
 * Full server URL for internal HTTP calls
 */
export const SERVER_URL = process.env.CACO_SERVER_URL || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────────────────────
// Timeouts and Intervals (all in milliseconds unless noted)
// ─────────────────────────────────────────────────────────────

/** Message dispatch timeout - max time to wait for SDK stream completion */
export const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Schedule manager check interval */
export const SCHEDULE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Delay when scheduled session is busy */
export const SCHEDULE_BUSY_DELAY_MS = 60 * 60 * 1000; // 1 hour

/** Restarter poll interval when waiting for port */
export const RESTARTER_POLL_MS = 500;

/** Restarter max wait time */
export const RESTARTER_TIMEOUT_MS = 30 * 1000; // 30 seconds

// ─────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────

/** Output cache TTL */
export const OUTPUT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Model list cache TTL */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────

/** Max file size for /api/file endpoint */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/** Max file size for legacy /api/files/read endpoint */
export const MAX_LEGACY_FILE_SIZE_BYTES = 100 * 1024; // 100KB

/** Command execution timeout */
export const EXEC_TIMEOUT_MS = 60 * 1000; // 60 seconds

/** Command max output buffer */
export const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB

// ─────────────────────────────────────────────────────────────
// Agent Runaway Guard
// ─────────────────────────────────────────────────────────────

/** Max effective call depth for agent chains */
export const AGENT_MAX_DEPTH = 2;

/** Max age of a correlation flow (seconds) */
export const AGENT_MAX_AGE_SECONDS = 60 * 60; // 1 hour

/** Max agent calls per time window */
export const AGENT_RATE_LIMIT_CALLS = 10;

/** Agent rate limit window (seconds) */
export const AGENT_RATE_LIMIT_WINDOW_SECONDS = 60;
