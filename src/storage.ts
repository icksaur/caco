/**
 * Caco storage layer — façade.
 *
 * Historically this was a single 850-line god-module. It is now a thin
 * re-export surface so existing import sites (12+ files) keep working
 * while the implementations live in focused per-domain modules:
 *
 *   storage-paths       — STORAGE_ROOT and per-session directory helpers
 *   session-meta-store  — meta.json, observed/idle, intent, session order, icon
 *   session-data-store  — generic per-session JSON blobs
 *   roadmap-store       — roadmap.json + NDJSON notes
 *   output-store        — outputs, activities, cwd↔session registry, language detection
 *   mcp-auth-store      — global MCP OAuth tokens
 *   peer-store          — known Caco peers
 *
 * New code should import directly from the focused modules. This façade is
 * retained only to keep existing imports compiling.
 */

export type { SessionKind, SessionMeta } from './session-meta-store.js';
export {
  ensureSessionMeta, getSessionMeta, setSessionMeta,
  getSessionIconPath,
  markSessionObserved, markSessionIdle, isSessionUnobserved,
  setSessionIntent,
  getSessionOrder, setSessionOrder,
} from './session-meta-store.js';

export {
  isValidDataName, listSessionData, getSessionData, setSessionData, deleteSessionData,
} from './session-data-store.js';

export type { RoadmapStep, Roadmap, NoteEntry } from './roadmap-store.js';
export {
  getSessionRoadmap, setSessionRoadmap,
  getSessionNotes, appendSessionNote, archiveSessionNote,
} from './roadmap-store.js';

export type { OutputMetadata, StoredOutput, ActivityMetadata, StoredActivity } from './output-store.js';
export {
  registerSession, unregisterSession,
  storeOutput, getOutput, listOutputs, listEmbedOutputs, parseOutputMarkers, pruneOutputs,
  storeActivity, getActivity, listActivities,
  detectLanguage,
} from './output-store.js';

export type { MCPAuthState, MCPAuthStore } from './mcp-auth-store.js';
export {
  getMcpAuth, setMcpAuth, getMcpServerAuth, setMcpServerAuth, removeMcpServerAuth,
} from './mcp-auth-store.js';

export type { CacoPeer } from './peer-store.js';
export { getPeers, setPeers } from './peer-store.js';
