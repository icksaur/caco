/**
 * Usage metrics HTTP surface — read-only queries over the durable usage store.
 *
 *   GET /api/usage/hourly?days=N      → { from, to, buckets: HourlyBucket[] }
 *   GET /api/usage/records?from&to&limit → { from, to, records } | 400
 *
 * Query parsing is pure + exported (parseHourlyQuery/parseRecordsQuery) so the
 * clamp/validation contract is unit-testable without a live Express app.
 */

import { Router, Request, Response } from 'express';
import { aggregateHourly, readUsageRecords, type HourlyBucket } from '../usage-store.js';
import type { UsageRecord } from '../usage-metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** days → an [from, to] ISO window ending at `now`. Bad/absent days → default 7;
 *  clamped to [1, MAX_DAYS]. */
export function parseHourlyQuery(
  query: { days?: string },
  now: number = Date.now(),
): { from: string; to: string; days: number } {
  const parsed = Number.parseInt(query.days ?? '', 10);
  const days = Number.isFinite(parsed) ? clamp(parsed, 1, MAX_DAYS) : DEFAULT_DAYS;
  return {
    from: new Date(now - days * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
    days,
  };
}

/** Validate the records window + limit. Returns an { error } message (the 400
 *  body) or the resolved params. Absent from/to default to a 7-day window. */
export function parseRecordsQuery(
  query: { from?: string; to?: string; limit?: string },
  now: number = Date.now(),
): { error: string } | { from: string; to: string; limit: number } {
  let from: number;
  if (query.from === undefined) {
    from = now - DEFAULT_DAYS * DAY_MS;
  } else {
    from = new Date(query.from).getTime();
    if (!Number.isFinite(from)) return { error: 'from must be an ISO timestamp' };
  }
  let to: number;
  if (query.to === undefined) {
    to = now;
  } else {
    to = new Date(query.to).getTime();
    if (!Number.isFinite(to)) return { error: 'to must be an ISO timestamp' };
  }
  if (to < from) return { error: 'to must be >= from' };
  // Clamp the window WIDTH to MAX_DAYS so an over-wide range can't drive an
  // unbounded day-file scan (keeps the bounded-partition invariant); keep the
  // most-recent end of the window.
  if (to - from > MAX_DAYS * DAY_MS) from = to - MAX_DAYS * DAY_MS;
  const parsedLimit = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isFinite(parsedLimit) ? clamp(parsedLimit, 1, MAX_LIMIT) : DEFAULT_LIMIT;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit };
}

/** Backing handler for GET /usage/hourly. */
export function getHourlyPayload(
  query: { days?: string },
  now: number = Date.now(),
): { from: string; to: string; buckets: HourlyBucket[] } {
  const { from, to } = parseHourlyQuery(query, now);
  return { from, to, buckets: aggregateHourly(from, to) };
}

/** Backing handler for GET /usage/records. Returns { error } on a bad window.
 *  Yields the MOST RECENT `limit` records (newest first) so an investigation
 *  query never silently hides the latest activity, plus a `truncated` flag. */
export function getRecordsPayload(
  query: { from?: string; to?: string; limit?: string },
  now: number = Date.now(),
): { error: string } | { from: string; to: string; records: UsageRecord[]; truncated: boolean } {
  const parsed = parseRecordsQuery(query, now);
  if ('error' in parsed) return parsed;
  const all = readUsageRecords(parsed.from, parsed.to);
  const truncated = all.length > parsed.limit;
  const records = all.slice(-parsed.limit).reverse();
  return { from: parsed.from, to: parsed.to, records, truncated };
}

const router = Router();

router.get('/usage/hourly', (req: Request, res: Response) => {
  res.json(getHourlyPayload(req.query as { days?: string }));
});

router.get('/usage/records', (req: Request, res: Response) => {
  const payload = getRecordsPayload(req.query as { from?: string; to?: string; limit?: string });
  if ('error' in payload) {
    res.status(400).json(payload);
    return;
  }
  res.json(payload);
});

export { router };
