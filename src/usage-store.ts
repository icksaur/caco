/**
 * Durable usage store: append-only JSONL partitioned by UTC day
 * (~/.caco/metrics/usage/YYYY-MM-DD.jsonl). Partitioning bounds a windowed
 * read to the ≤(window-days + 1) day-files it intersects rather than the whole
 * history. Best-effort: writes never throw into the dispatch path; corrupt/
 * partial lines are skipped on read. Single-process (no cross-process lock).
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT } from './storage-paths.js';
import type { UsageRecord } from './usage-metrics.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function usageDir(): string {
  return join(STORAGE_ROOT, 'metrics', 'usage');
}

/** UTC date key (YYYY-MM-DD) for an ISO timestamp. */
function dayKey(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function dayFilePath(dayKeyStr: string): string {
  return join(usageDir(), `${dayKeyStr}.jsonl`);
}

/** The day-partition file paths intersecting [fromTs, toTs] (inclusive), whether
 *  or not they exist. Bounds read I/O to the window. */
export function dayFilesInWindow(fromTs: string, toTs: string): string[] {
  const from = new Date(fromTs).getTime();
  const to = new Date(toTs).getTime();
  if (!isFinite(from) || !isFinite(to) || to < from) return [];
  const out: string[] = [];
  // Start at UTC midnight of the from-day, step one day until past to.
  const startDay = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate());
  for (let t = startDay; t <= to; t += DAY_MS) {
    out.push(dayFilePath(new Date(t).toISOString().slice(0, 10)));
  }
  return out;
}

/** Append one record to its UTC-day partition. Synchronous single-line append
 *  (atomic per line) so parallel sessions never interleave. Best-effort. */
export function appendUsageRecord(record: UsageRecord): void {
  try {
    const dir = usageDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(dayFilePath(dayKey(record.ts)), JSON.stringify(record) + '\n');
  } catch {
    /* best-effort telemetry; never disturb dispatch */
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
}
const fileCache = new Map<string, CacheEntry>();

function readDayFile(path: string): UsageRecord[] {
  if (!existsSync(path)) return [];
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  const cached = fileCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.records;
  }
  const records: UsageRecord[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as UsageRecord);
      } catch {
        /* skip corrupt/partial line */
      }
    }
  } catch {
    return [];
  }
  fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, records });
  return records;
}

/** Records whose ts is within [fromTs, toTs], ascending by ts. Reads only the
 *  day-files intersecting the window. */
export function readUsageRecords(fromTs: string, toTs: string): UsageRecord[] {
  const from = new Date(fromTs).getTime();
  const to = new Date(toTs).getTime();
  if (!isFinite(from) || !isFinite(to) || to < from) return [];
  const out: UsageRecord[] = [];
  for (const path of dayFilesInWindow(fromTs, toTs)) {
    for (const r of readDayFile(path)) {
      const t = new Date(r.ts).getTime();
      if (isFinite(t) && t >= from && t <= to) out.push(r);
    }
  }
  out.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return out;
}

export interface HourlyBucket {
  hour: string;
  /** Sum of priced requests' credits; null when the hour has requests but none priced. */
  credits: number | null;
  pricedRequests: number;
  unpricedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** UTC-hour buckets over [fromTs, toTs], dense (every hour present). `credits`
 *  sums only priced requests; an all-unpriced hour is null (distinct from an
 *  empty hour's 0). Pure over the read rows. */
export function aggregateHourly(fromTs: string, toTs: string): HourlyBucket[] {
  const from = new Date(fromTs).getTime();
  const to = new Date(toTs).getTime();
  if (!isFinite(from) || !isFinite(to) || to < from) return [];
  const records = readUsageRecords(fromTs, toTs);
  const byHour = new Map<string, HourlyBucket>();
  const hourKey = (ms: number): string => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();

  const startHour = Math.floor(from / HOUR_MS) * HOUR_MS;
  for (let t = startHour; t <= to; t += HOUR_MS) {
    const hour = new Date(t).toISOString();
    byHour.set(hour, { hour, credits: 0, pricedRequests: 0, unpricedRequests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  }

  for (const r of records) {
    const bucket = byHour.get(hourKey(new Date(r.ts).getTime()));
    if (!bucket) continue;
    bucket.inputTokens += r.inputTokens;
    bucket.cachedTokens += r.cachedTokens;
    bucket.outputTokens += r.outputTokens;
    if (r.requestCredits === null || r.requestCredits === undefined) {
      bucket.unpricedRequests += 1;
    } else {
      bucket.pricedRequests += 1;
      bucket.credits = (bucket.credits ?? 0) + r.requestCredits;
    }
  }

  // An hour with requests but none priced → credits: null.
  for (const bucket of byHour.values()) {
    if (bucket.pricedRequests === 0 && bucket.unpricedRequests > 0) bucket.credits = null;
  }

  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}
