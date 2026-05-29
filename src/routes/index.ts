/**
 * Routes Index
 * 
 * Exports all route modules for the server.
 */

export { router as sessionRoutes } from './sessions.js';
export { router as apiRoutes } from './api.js';
export { router as sessionMessageRoutes } from './session-messages.js';
export { router as workspaceRoutes } from './workspace-api.js';
export { router as mcpAuthRoutes } from './mcp-auth.js';
export { router as scheduleRoutes } from './schedule.js';
export { router as shellRoutes } from './shell.js';
export { router as surfaceRoutes } from './surface.js';
export { router as watchRoutes } from './watch.js';
