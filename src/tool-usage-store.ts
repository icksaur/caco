/**
 * System-wide tool-usage store (spec-tool-reveal Phase C1).
 *
 * Feeds cold-resume auto-defer: which tools are STALE (unused for longer than the
 * threshold) and therefore defer candidates at the next cold resume. Two pieces of
 * durable state:
 *
 *  - a monotonic **active-seconds clock** — accumulated time during which tools are
 *    actually being used, NOT calendar time. Advanced lazily on each interaction by
 *    the real elapsed wall-time since the previous tick, CAPPED per gap
 *    (`MAX_ACTIVE_GAP_SECONDS`) so an idle stretch (lunch, overnight, process-down)
 *    does not age tools. In active work — where some tool fires every few
 *    seconds/minutes — this tracks real elapsed time; it only diverges from
 *    wall-clock during genuine idle, which is exactly what we want to exclude. This
 *    is the faithful, self-contained realization of the spec's "advances only while
 *    active" clock without coupling the store to session lifecycle.
 *
 *  - a per-tool **lastUsedActiveSeconds** stamp (keyed by the canonical `ToolKey` —
 *    the SAME key `excludedTools`, the meter, and the classifier use), written from
 *    the single `tool.execution_start` metering seam. One number per tool, no decay.
 *
 * The store reports only usage FACTS (clock value + per-tool stamps). Whether a tool
 * is defer-ELIGIBLE (origin-based) and the cold-resume VERDICT are policy computed by
 * the caller against `computeColdResumeExclusions` / this module's threshold, so there
 * is exactly one verdict definition and the diagnostic view can never disagree with
 * what auto-defer would actually do.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ToolKey } from './tool-key.js';

const STORE_FILE = join(homedir(), '.caco', 'tool-usage.json');

/** Per-gap cap on active-clock advance (seconds). A gap longer than this counts as
 *  only this much active time — so idle stretches (overnight, process-down) don't age
 *  tools past the staleness threshold. 5 minutes. */
export const MAX_ACTIVE_GAP_SECONDS = 5 * 60;

/** A tool unused for more than this many ACTIVE-clock seconds is stale → a defer
 *  candidate at the next cold resume (spec: "2 active-hours"). */
export const DEFER_STALE_THRESHOLD_ACTIVE_SECONDS = 2 * 60 * 60;

/**
 * Wall-clock staleness that makes a RESUME "cold" for auto-defer (spec coldness
 * signal (2): `now − lastUsedAt > cache TTL` — the provider prompt-cache prefix is
 * evicted, so applying an exclusion is free). Set to the provider prompt-cache TTL
 * (Anthropic ephemeral cache default is ~5 min); resuming a session untouched for
 * longer than this is provably cold, so auto-defer costs no cache-bust. Conservative
 * by design: a resume WITHIN the window is treated as possibly-warm and NOT
 * auto-deferred. A later refinement can use the B0 ground-truth `cacheReadTokens≈0`
 * signal to defer even inside the window when coldness is proven. ms.
 */
export const COLD_RESUME_STALE_MS = 5 * 60 * 1000;

let accumulatedActiveSeconds = 0;
const lastUsed = new Map<ToolKey, number>();
let lastTickMs = Date.now();
let loaded = false;

let clockMs: () => number = () => Date.now();

interface PersistShape {
  activeSeconds: number;
  lastUsed: Record<string, number>;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  // Reset the tick anchor to NOW on load so time the process was down counts as idle
  // (never advances the active clock across a restart).
  lastTickMs = clockMs();
  try {
    const data = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as PersistShape;
    if (typeof data.activeSeconds === 'number' && data.activeSeconds >= 0) {
      accumulatedActiveSeconds = data.activeSeconds;
    }
    if (data.lastUsed && typeof data.lastUsed === 'object') {
      for (const [k, v] of Object.entries(data.lastUsed)) {
        if (typeof v === 'number') lastUsed.set(k as ToolKey, v);
      }
    }
  } catch {
    // No file yet — start at zero.
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const shape: PersistShape = {
      activeSeconds: accumulatedActiveSeconds,
      lastUsed: Object.fromEntries(lastUsed),
    };
    writeFileSync(STORE_FILE, JSON.stringify(shape), 'utf-8');
  } catch (e) {
    // A heuristic fed from a hot path: log loudly (measurement WITH an error path)
    // but never throw into dispatch — a lost stamp only makes a tool look slightly
    // less recently used.
    console.error('[TOOLS] tool-usage-store persist failed:', e instanceof Error ? e.message : e);
  }
}

/** Advance the active clock by the capped real-time gap since the previous tick. */
function tick(): void {
  const now = clockMs();
  const elapsedSeconds = Math.max(0, (now - lastTickMs) / 1000);
  accumulatedActiveSeconds += Math.min(elapsedSeconds, MAX_ACTIVE_GAP_SECONDS);
  lastTickMs = now;
}

/** Stamp that a tool was invoked (system-wide), at the current active-clock value.
 *  Called from the one `tool.execution_start` seam, keyed by the canonical ToolKey. */
export function stampToolUsage(key: ToolKey): void {
  ensureLoaded();
  tick();
  lastUsed.set(key, accumulatedActiveSeconds);
  persist();
}

/** Current active-clock value (seconds). Advances the clock as a side effect. */
export function getNowActiveSeconds(): number {
  ensureLoaded();
  tick();
  return accumulatedActiveSeconds;
}

/** Per-tool last-used active-clock stamps (the map `computeColdResumeExclusions`
 *  consumes as `lastUsed`). A key absent from the map = never used = maximally stale. */
export function getLastUsedActiveSeconds(): ReadonlyMap<ToolKey, number> {
  ensureLoaded();
  return lastUsed;
}

/** Test-only: clear all state and force a reload on next access. */
export function _resetUsageStoreForTest(): void {
  accumulatedActiveSeconds = 0;
  lastUsed.clear();
  lastTickMs = clockMs();
  loaded = false;
}

/** Test-only: override the wall clock (ms) driving the active-seconds clock. */
export function _setClockForTest(fn: () => number): void {
  clockMs = fn;
  lastTickMs = fn();
}
