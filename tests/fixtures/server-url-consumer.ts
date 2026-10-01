// Consumes SERVER_URL exactly as agent-tools, delegate-tool, herd-runtime,
// herd-tools, and schedule-manager do: a static named import, read at call time.
import { SERVER_URL } from '../../src/config.js';

export function readServerUrl(): string {
  return SERVER_URL;
}
