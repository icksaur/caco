/**
 * Output, activity, and language-detection storage.
 *
 * Outputs are persistent tool results (file dumps, terminal captures, images,
 * embed payloads) stored under ~/.caco/sessions/<id>/outputs/. Each output
 * is a data file plus a sibling .meta.json describing it.
 *
 * Activities are SDK event traces (intent + tool calls) stored under
 * ~/.caco/sessions/<id>/activity/.
 *
 * Output is keyed directly by sessionId: the owning session's `SessionIdRef` is
 * threaded into every tool, so callers pass the resolved id. (cwd is not a
 * session identity — multiple sessions can share a repo.)
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, getSessionOutputDir, ensureDir } from './storage-paths.js';
import { OUTPUT_CACHE_TTL_MS } from './config.js';

export interface OutputMetadata {
  type: 'file' | 'terminal' | 'image' | 'embed' | 'raw';
  createdAt: string;
  sessionId: string;
  sessionCwd?: string;
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

export interface ActivityMetadata {
  type: string;          // SDK event type (e.g. 'assistant.intent', 'tool.execution_start')
  text: string;
  details?: string;
  createdAt: string;
  sessionId: string;
}

export interface StoredActivity {
  id: string;
  metadata: ActivityMetadata;
}

interface CacheEntry {
  data: string | Buffer;
  metadata: OutputMetadata;
  cachedAt: number;
}

const outputCache = new Map<string, CacheEntry>();

function generateOutputId(): string {
  return `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store output to disk under the owning session's directory.
 *
 * @param sessionId - Owning session id (resolved from the session's SessionIdRef)
 * @param sessionCwd - Session's working directory (informational metadata only)
 * @param data - Content to store
 * @param metadata - Output metadata (must include type)
 * @returns Output ID for retrieval
 */
export function storeOutput(
  sessionId: string,
  sessionCwd: string,
  data: string | Buffer,
  metadata: { type: OutputMetadata['type']; [key: string]: unknown }
): string {
  const createdAt = new Date().toISOString();

  const fullMetadata: OutputMetadata = {
    ...metadata,
    type: metadata.type,
    createdAt,
    sessionId,
    sessionCwd,
  };

  const outputId = generateOutputId();
  const outputDir = getSessionOutputDir(sessionId);
  ensureDir(outputDir);

  const ext = metadata.type === 'image' ? 'b64' :
              metadata.type === 'embed' ? 'json' : 'txt';

  writeFileSync(join(outputDir, `${outputId}.${ext}`), data);
  writeFileSync(join(outputDir, `${outputId}.meta.json`), JSON.stringify(fullMetadata, null, 2));

  outputCache.set(outputId, { data, metadata: fullMetadata, cachedAt: Date.now() });
  setTimeout(() => outputCache.delete(outputId), OUTPUT_CACHE_TTL_MS);

  return outputId;
}

export function getOutput(outputId: string): StoredOutput | null {
  const cached = outputCache.get(outputId);
  if (cached) {
    return { data: cached.data, metadata: cached.metadata };
  }

  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  for (const sessionId of readdirSync(sessionsDir)) {
    const outputDir = getSessionOutputDir(sessionId);
    if (!existsSync(outputDir)) continue;

    const metaPath = join(outputDir, `${outputId}.meta.json`);
    if (!existsSync(metaPath)) continue;

    try {
      const metadata: OutputMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const files = readdirSync(outputDir);
      const dataFile = files.find(f => f.startsWith(outputId) && !f.endsWith('.meta.json'));
      if (!dataFile) continue;

      const dataPath = join(outputDir, dataFile);
      const isTextFile = dataFile.endsWith('.txt') || dataFile.endsWith('.json');
      const data = isTextFile
        ? readFileSync(dataPath, 'utf-8')
        : readFileSync(dataPath);

      outputCache.set(outputId, { data, metadata, cachedAt: Date.now() });
      setTimeout(() => outputCache.delete(outputId), OUTPUT_CACHE_TTL_MS);

      return { data, metadata };
    } catch (e) {
      console.error(`[storage] Error reading output ${outputId}:`, e);
    }
  }

  return null;
}

export function listOutputs(sessionId: string): OutputMetadata[] {
  const outputDir = getSessionOutputDir(sessionId);
  if (!existsSync(outputDir)) return [];

  const outputs: OutputMetadata[] = [];
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      outputs.push(JSON.parse(readFileSync(join(outputDir, file), 'utf-8')));
    } catch { /* skip malformed */ }
  }
  return outputs;
}

export function listEmbedOutputs(sessionId: string): Array<{ outputId: string; metadata: OutputMetadata }> {
  const outputDir = getSessionOutputDir(sessionId);
  if (!existsSync(outputDir)) return [];

  const embeds: Array<{ outputId: string; metadata: OutputMetadata }> = [];
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const metadata: OutputMetadata = JSON.parse(readFileSync(join(outputDir, file), 'utf-8'));
      if (metadata.type === 'embed') {
        embeds.push({ outputId: file.replace('.meta.json', ''), metadata });
      }
    } catch { /* skip malformed */ }
  }

  embeds.sort((a, b) =>
    new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
  );
  return embeds;
}

/**
 * Parse [output:xxx] markers from text. Used by history replay to find
 * output references embedded in tool result text.
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
 * Count outputs older than maxAgeDays. (Currently counts only; does not delete.)
 */
export function pruneOutputs(maxAgeDays: number = 30): number {
  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) return 0;

  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  let deleted = 0;

  for (const sessionId of readdirSync(sessionsDir)) {
    const outputDir = getSessionOutputDir(sessionId);
    if (!existsSync(outputDir)) continue;
    for (const file of readdirSync(outputDir)) {
      const stats = statSync(join(outputDir, file));
      if (stats.mtimeMs < cutoff) deleted++;
    }
  }
  return deleted;
}

function getActivityDir(sessionId: string): string {
  return join(STORAGE_ROOT, 'sessions', sessionId, 'activity');
}

export function storeActivity(
  sessionId: string,
  type: ActivityMetadata['type'],
  text: string,
  details?: string
): string {
  const activityId = `activity_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const activityDir = getActivityDir(sessionId);
  ensureDir(activityDir);

  const metadata: ActivityMetadata = {
    type, text, details,
    createdAt: new Date().toISOString(),
    sessionId,
  };

  writeFileSync(join(activityDir, `${activityId}.json`), JSON.stringify(metadata, null, 2), 'utf-8');
  return activityId;
}

export function getActivity(activityId: string): StoredActivity | null {
  const sessionsDir = join(STORAGE_ROOT, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  for (const sessionId of readdirSync(sessionsDir)) {
    const activityPath = join(sessionsDir, sessionId, 'activity', `${activityId}.json`);
    if (!existsSync(activityPath)) continue;
    try {
      const metadata = JSON.parse(readFileSync(activityPath, 'utf-8')) as ActivityMetadata;
      return { id: activityId, metadata };
    } catch (error) {
      console.error(`Failed to read activity ${activityId}:`, error);
      return null;
    }
  }
  return null;
}

export function listActivities(sessionId: string): StoredActivity[] {
  const activityDir = getActivityDir(sessionId);
  if (!existsSync(activityDir)) return [];

  const activities: StoredActivity[] = [];
  for (const file of readdirSync(activityDir)) {
    if (!file.endsWith('.json')) continue;
    const activityId = file.replace('.json', '');
    const activity = getActivity(activityId);
    if (activity) activities.push(activity);
  }

  return activities.sort((a, b) =>
    a.metadata.createdAt.localeCompare(b.metadata.createdAt)
  );
}

const LANG_MAP: Record<string, string> = {
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
  env: 'shell',
};

export function detectLanguage(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() ?? '';
  return LANG_MAP[ext] || 'plaintext';
}
