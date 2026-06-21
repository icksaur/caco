/**
 * Append-only per-request metrics log — the persistence layer of the tool-diet
 * benchmark harness. Each completed request appends one JSONL row tagged with
 * the Caco repo's git sha, so before/after comparisons across a diet change are
 * keyed by commit with no manual labeling. Best-effort: logging never throws
 * into the dispatch path.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { STORAGE_ROOT } from './storage-paths.js';
import type { RequestMetricsRow } from './session-throughput.js';

const LOG_PATH = join(STORAGE_ROOT, 'metrics', 'requests.jsonl');

export interface LoggedRequestMetrics extends RequestMetricsRow {
  sessionId: string;
  gitSha: string;
  ts: string;
}

const shaCache = new Map<string, string>();

function gitSha(cwd: string): string {
  const cached = shaCache.get(cwd);
  if (cached) return cached;
  let sha = 'unknown';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    sha = 'unknown';
  }
  shaCache.set(cwd, sha);
  return sha;
}

export function appendRequestMetrics(sessionId: string, row: RequestMetricsRow, repoCwd: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const entry: LoggedRequestMetrics = { sessionId, gitSha: gitSha(repoCwd), ts: new Date().toISOString(), ...row };
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    /* best-effort telemetry; never disturb dispatch */
  }
}

export function readRequestMetrics(): LoggedRequestMetrics[] {
  if (!existsSync(LOG_PATH)) return [];
  const out: LoggedRequestMetrics[] = [];
  for (const line of readFileSync(LOG_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LoggedRequestMetrics);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}
