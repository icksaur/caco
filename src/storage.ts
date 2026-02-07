/**
 * Persistent Storage Layer
 * 
 * Stores display tool outputs and applet data on disk.
 * Storage root: ~/.caco/
 * 
 * Structure:
 *   ~/.caco/
 *   ├── sessions/<sessionId>/
 *   │   ├── meta.json               # Session metadata (custom name)
 *   │   └── outputs/                # Display tool outputs
 *   └── applets/<slug>/             # Saved applets
 * 
 * Note: SDK stores session data in ~/.copilot/session-state/{id}/workspace.yaml
 * We store Caco-specific metadata separately to avoid coupling with SDK internals.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { OUTPUT_CACHE_TTL_MS } from './config.js';

// Storage root (~/.caco, set once at module load)
const STORAGE_ROOT = join(homedir(), '.caco');

// In-memory cache for frequently accessed outputs (avoids disk reads)
const outputCache = new Map<string, CacheEntry>();

interface CacheEntry {
  data: string | Buffer;
  metadata: OutputMetadata;
  cachedAt: number;
}

/**
 * Session metadata stored in ~/.caco/sessions/<id>/meta.json
 */
export interface SessionMeta {
  name: string;
  lastObservedAt?: string;  // ISO timestamp: user last viewed this session
  lastIdleAt?: string;      // ISO timestamp: session last became idle
  currentIntent?: string;   // Last reported intent (from report_intent tool)
}

export interface OutputMetadata {
  type: 'file' | 'terminal' | 'image' | 'embed' | 'raw';
  createdAt: string;
  sessionCwd: string;
  path?: string;
  command?: string;
  highlight?: string;
  mimeType?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  [key: string]: unknown;
}

export interface StoredOutput {
  data: string | Buffer;
  metadata: OutputMetadata;
}

/**
 * Session ID lookup by CWD
 * 
 * Since tools are created with sessionCwd in closure, but we want to store
 * by sessionId, we need a way to resolve cwd → sessionId.
 * 
 * This is set by session-manager when sessions are created/resumed.
 */
const cwdToSessionId = new Map<string, string>();

export function registerSession(cwd: string, sessionId: string): void {
  cwdToSessionId.set(cwd, sessionId);
}

export function unregisterSession(cwd: string): void {
  cwdToSessionId.delete(cwd);
}

function getSessionIdForCwd(cwd: string): string | undefined {
  return cwdToSessionId.get(cwd);
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get storage path for a session
 */
function getSessionDir(sessionId: string): string {
  return join(STORAGE_ROOT, 'sessions', sessionId);
}

/**
 * Get storage path for a session's outputs
 */
function getSessionOutputDir(sessionId: string): string {
  return join(getSessionDir(sessionId), 'outputs');
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Ensure session meta.json exists with default values
 * Called from session-manager on create/resume (NOT from registerSession)
 */
export function ensureSessionMeta(sessionId: string): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  const metaPath = join(sessionDir, 'meta.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({ name: '' }, null, 2));
  }
}

/**
 * Get session metadata
 */
export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const metaPath = join(getSessionDir(sessionId), 'meta.json');
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * Set session metadata
 */
export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

/**
 * Mark session as observed (user viewed it)
 * Updates lastObservedAt timestamp
 */
export function markSessionObserved(sessionId: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.lastObservedAt = new Date().toISOString();
  setSessionMeta(sessionId, meta);
  console.log(`[STORAGE] markSessionObserved: ${sessionId.slice(0, 8)} lastObservedAt=${meta.lastObservedAt}`);
}

/**
 * Mark session as idle (completed processing)
 * Updates lastIdleAt timestamp
 */
export function markSessionIdle(sessionId: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.lastIdleAt = new Date().toISOString();
  setSessionMeta(sessionId, meta);
  console.log(`[STORAGE] markSessionIdle: ${sessionId.slice(0, 8)} lastIdleAt=${meta.lastIdleAt}`);
}

/**
 * Set session's current intent
 */
export function setSessionIntent(sessionId: string, intent: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.currentIntent = intent;
  setSessionMeta(sessionId, meta);
}

/**
 * Check if session is unobserved (idle occurred after last observation)
 */
export function isSessionUnobserved(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId);
  if (!meta?.lastIdleAt) return false; // Never went idle
  if (!meta.lastObservedAt) return true; // Never observed
  const result = new Date(meta.lastIdleAt) > new Date(meta.lastObservedAt);
  // DEBUG: Log unobserved check
  if (result) {
    console.log(`[STORAGE] isSessionUnobserved: ${sessionId.slice(0, 8)} = true (idle=${meta.lastIdleAt}, obs=${meta.lastObservedAt})`);
  }
  return result;
}

/**
 * Generate unique output ID
 */
function generateOutputId(): string {
  return `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store output to disk
 * 
 * @param sessionCwd - Session's working directory (used to look up sessionId)
 * @param data - Content to store
 * @param metadata - Output metadata (must include type)
 * @returns Output ID for retrieval
 */
export function storeOutput(
  sessionCwd: string,
  data: string | Buffer,
  metadata: { type: OutputMetadata['type']; [key: string]: unknown }
): string {
  const sessionId = getSessionIdForCwd(sessionCwd);
  const createdAt = new Date().toISOString();
  
  const fullMetadata: OutputMetadata = {
    ...metadata,
    type: metadata.type,
    createdAt,
    sessionCwd
  };
  
  if (!sessionId) {
    // Fallback: use old in-memory behavior if session not registered
    // This shouldn't happen in normal flow, but provides graceful degradation
    console.warn(`[storage] No session registered for cwd: ${sessionCwd}, using memory cache`);
    return storeInMemory(data, fullMetadata);
  }
  
  const outputId = generateOutputId();
  const outputDir = getSessionOutputDir(sessionId);
  ensureDir(outputDir);
  
  // Determine file extension based on content type
  const ext = metadata.type === 'image' ? 'b64' : 
              metadata.type === 'embed' ? 'json' : 'txt';
  
  // Write data file
  const dataPath = join(outputDir, `${outputId}.${ext}`);
  writeFileSync(dataPath, data);
  
  // Write metadata file
  const metaPath = join(outputDir, `${outputId}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(fullMetadata, null, 2));
  
  // Cache it
  outputCache.set(outputId, {
    data,
    metadata: fullMetadata,
    cachedAt: Date.now()
  });
  
  // Auto-cleanup cache after TTL
  setTimeout(() => outputCache.delete(outputId), OUTPUT_CACHE_TTL_MS);
  
  return outputId;
}

/**
 * Fallback in-memory storage (used when session not registered)
 */
function storeInMemory(data: string | Buffer, metadata: OutputMetadata): string {
  const outputId = generateOutputId();
  
  outputCache.set(outputId, {
    data,
    metadata,
    cachedAt: Date.now()
  });
  
  setTimeout(() => outputCache.delete(outputId), OUTPUT_CACHE_TTL_MS);
  
  return outputId;
}

/**
 * Retrieve output from disk or cache
 */
export function getOutput(outputId: string): StoredOutput | null {
  // Check cache first
  const cached = outputCache.get(outputId);
  if (cached) {
    return { data: cached.data, metadata: cached.metadata };
  }
  
  // Search all session directories for this output
  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) {
    return null;
  }
  
  for (const sessionId of readdirSync(sessionsDir)) {
    const outputDir = getSessionOutputDir(sessionId);
    if (!existsSync(outputDir)) continue;
    
    // Look for metadata file
    const metaPath = join(outputDir, `${outputId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const metadata: OutputMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
        
        // Find the data file (could be .txt, .b64, or .json)
        const files = readdirSync(outputDir);
        const dataFile = files.find(f => f.startsWith(outputId) && !f.endsWith('.meta.json'));
        
        if (dataFile) {
          const dataPath = join(outputDir, dataFile);
          // Read as string for text types, buffer for binary (images)
          const isTextFile = dataFile.endsWith('.txt') || dataFile.endsWith('.json');
          const data = isTextFile 
            ? readFileSync(dataPath, 'utf-8')
            : readFileSync(dataPath);
          
          // Cache for future access
          outputCache.set(outputId, {
            data,
            metadata,
            cachedAt: Date.now()
          });
          setTimeout(() => outputCache.delete(outputId), OUTPUT_CACHE_TTL_MS);
          
          return { data, metadata };
        }
      } catch (e) {
        console.error(`[storage] Error reading output ${outputId}:`, e);
      }
    }
  }
  
  return null;
}

/**
 * List all outputs for a session
 */
export function listOutputs(sessionId: string): OutputMetadata[] {
  const outputDir = getSessionOutputDir(sessionId);
  if (!existsSync(outputDir)) {
    return [];
  }
  
  const outputs: OutputMetadata[] = [];
  
  for (const file of readdirSync(outputDir)) {
    if (file.endsWith('.meta.json')) {
      try {
        const metaPath = join(outputDir, file);
        const metadata: OutputMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
        outputs.push(metadata);
      } catch (e) {
        // Skip malformed files
      }
    }
  }
  
  return outputs;
}

/**
 * List embed outputs for a session (for history replay)
 * Returns outputId + metadata for each embed type output
 */
export function listEmbedOutputs(sessionId: string): Array<{ outputId: string; metadata: OutputMetadata }> {
  const outputDir = getSessionOutputDir(sessionId);
  if (!existsSync(outputDir)) {
    return [];
  }
  
  const embeds: Array<{ outputId: string; metadata: OutputMetadata }> = [];
  
  for (const file of readdirSync(outputDir)) {
    if (file.endsWith('.meta.json')) {
      try {
        const metaPath = join(outputDir, file);
        const metadata: OutputMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (metadata.type === 'embed') {
          // Extract outputId from filename (e.g., "out_12345_abc.meta.json" -> "out_12345_abc")
          const outputId = file.replace('.meta.json', '');
          embeds.push({ outputId, metadata });
        }
      } catch (e) {
        // Skip malformed files
      }
    }
  }
  
  // Sort by creation time
  embeds.sort((a, b) => 
    new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
  );
  
  return embeds;
}

/**
 * Parse [output:xxx] markers from text
 * Used when reloading history to find output references
 */
export function parseOutputMarkers(text: string): string[] {
  const regex = /\[output:([^\]]+)\]/g;
  const ids: string[] = [];
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  
  return ids;
}

/**
 * Prune old session outputs
 * @param maxAgeDays - Delete outputs older than this many days
 */
export function pruneOutputs(maxAgeDays: number = 30): number {
  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) {
    return 0;
  }
  
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  
  for (const sessionId of readdirSync(sessionsDir)) {
    const outputDir = getSessionOutputDir(sessionId);
    if (!existsSync(outputDir)) continue;
    
    for (const file of readdirSync(outputDir)) {
      const filePath = join(outputDir, file);
      const stats = statSync(filePath);
      
      if (stats.mtimeMs < cutoff) {
        // Would delete here - for now just count
        deleted++;
      }
    }
  }
  
  return deleted;
}

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() ?? '';
  const langMap: Record<string, string> = {
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

export interface ActivityMetadata {
  type: string;  // SDK event type (e.g., 'assistant.intent', 'tool.execution_start')
  text: string;
  details?: string;
  createdAt: string;
  sessionId: string;
}

export interface StoredActivity {
  id: string;
  metadata: ActivityMetadata;
}

/**
 * Store activity item to disk
 * Returns activityId for later retrieval
 */
export function storeActivity(
  sessionId: string,
  type: ActivityMetadata['type'],
  text: string,
  details?: string
): string {
  const activityId = `activity_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const sessionDir = join(STORAGE_ROOT, 'sessions', sessionId);
  const activityDir = join(sessionDir, 'activity');
  
  ensureDir(activityDir);
  
  const metadata: ActivityMetadata = {
    type,
    text,
    details,
    createdAt: new Date().toISOString(),
    sessionId
  };
  
  const activityPath = join(activityDir, `${activityId}.json`);
  writeFileSync(activityPath, JSON.stringify(metadata, null, 2), 'utf-8');
  
  return activityId;
}

/**
 * Retrieve activity item by ID
 */
export function getActivity(activityId: string): StoredActivity | null {
  // Find activity file across all sessions
  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  
  const sessionDirs = readdirSync(sessionsDir);
  
  for (const sessionId of sessionDirs) {
    const activityPath = join(sessionsDir, sessionId, 'activity', `${activityId}.json`);
    if (existsSync(activityPath)) {
      try {
        const content = readFileSync(activityPath, 'utf-8');
        const metadata = JSON.parse(content) as ActivityMetadata;
        return { id: activityId, metadata };
      } catch (error) {
        console.error(`Failed to read activity ${activityId}:`, error);
        return null;
      }
    }
  }
  
  return null;
}

/**
 * List all activity items for a session
 */
export function listActivities(sessionId: string): StoredActivity[] {
  const activityDir = join(STORAGE_ROOT, 'sessions', sessionId, 'activity');
  
  if (!existsSync(activityDir)) {
    return [];
  }
  
  const files = readdirSync(activityDir);
  const activities: StoredActivity[] = [];
  
  for (const file of files) {
    if (file.endsWith('.json')) {
      const activityId = file.replace('.json', '');
      const activity = getActivity(activityId);
      if (activity) {
        activities.push(activity);
      }
    }
  }
  
  // Sort by creation time
  return activities.sort((a, b) => 
    a.metadata.createdAt.localeCompare(b.metadata.createdAt)
  );
}
