/**
 * Event Bus
 *
 * Domain-layer entry point for broadcasting events to connected clients.
 * Re-exports the transport-layer implementation from routes/websocket so
 * domain modules don't reach upward into the route layer.
 *
 * If we ever swap WebSocket for another transport, this is the only file
 * domain code needs to change.
 */

export { broadcastGlobalEvent, broadcastEvent, type StatePushHandler } from './routes/websocket.js';
export type { SessionEvent } from './types.js';
