/**
 * Persistent Storage Layer
 * 
 * Stores display tool outputs and applet data on disk.
 * Storage root: ~/.caco/
 * 
 * Structure:
 *   ~/.caco/
 *   ├── sessions/<sessionId>/outputs/   # Display tool outputs
 *   └── applets/<slug>/                 # Saved applets
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Storage root (~/.caco, set once at module load)
const STORAGE_ROOT = join(homedir(), '.caco');

// In-memory cache for frequently accessed outputs (avoids disk reads)
const outputCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  data: string | Buffer;
  metadata: OutputMetadata;
  cachedAt: number;
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
 * Get storage path for a session's outputs
 */
function getSessionOutputDir(sessionId: string): string {
  return join(STORAGE_ROOT, 'sessions', sessionId, 'outputs');
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
  setTimeout(() => outputCache.delete(outputId), CACHE_TTL);
  
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
  
  setTimeout(() => outputCache.delete(outputId), CACHE_TTL);
  
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
          setTimeout(() => outputCache.delete(outputId), CACHE_TTL);
          
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
