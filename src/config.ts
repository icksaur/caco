/**
 * Server Configuration
 * 
 * Centralized configuration for port and server URL.
 * Environment variable priority: CACO_PORT → PORT → 3000
 */

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
