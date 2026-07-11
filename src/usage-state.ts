/**
 * Usage State
 * 
 * Tracks quota/budget usage from SDK's assistant.usage events.
 * The remainingPercentage from quotaSnapshots is stored here.
 * Persisted to ~/.caco/usage.json for display across server restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT } from './storage-paths.js';

export interface QuotaSnapshot {
  isUnlimitedEntitlement: boolean;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  resetDate?: string;
}

interface UsageInfo {
  remainingPercentage: number;
  resetDate?: string;
  isUnlimited: boolean;
  updatedAt: string;
  fromCache?: boolean;  // True if loaded from disk on startup
}

const USAGE_FILE = join(STORAGE_ROOT, 'usage.json');

// Global usage state (most recent from any session)
let currentUsage: UsageInfo | null = null;

/**
 * Load cached usage from disk on startup
 */
export function loadUsageCache(): void {
  try {
    const data = readFileSync(USAGE_FILE, 'utf-8');
    const cached = JSON.parse(data) as UsageInfo;
    cached.fromCache = true;
    currentUsage = cached;
  } catch {
    // No cache file or invalid - that's fine
  }
}

/**
 * Update usage from an assistant.usage event
 */
export function updateUsage(quotaSnapshots: Record<string, QuotaSnapshot> | undefined): { changed: boolean } {
  if (!quotaSnapshots) return { changed: false };

  const keys = Object.keys(quotaSnapshots);
  if (keys.length === 0) return { changed: false };

  const snapshot = quotaSnapshots[keys[0]];
  const next: UsageInfo = {
    remainingPercentage: snapshot.remainingPercentage,
    resetDate: snapshot.resetDate,
    isUnlimited: snapshot.isUnlimitedEntitlement,
    updatedAt: new Date().toISOString(),
    fromCache: false
  };

  const changed = !currentUsage
    || currentUsage.remainingPercentage !== next.remainingPercentage
    || currentUsage.resetDate !== next.resetDate
    || currentUsage.isUnlimited !== next.isUnlimited
    || currentUsage.fromCache === true;

  currentUsage = next;

  try {
    mkdirSync(STORAGE_ROOT, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(currentUsage, null, 2));
  } catch (err) {
    console.error('[USAGE] Failed to persist:', err);
  }

  return { changed };
}

/**
 * Get current usage info
 */
export function getUsage(): UsageInfo | null {
  return currentUsage;
}
