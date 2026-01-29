/**
 * Usage State
 * 
 * Tracks quota/budget usage from SDK's assistant.usage events.
 * The remainingPercentage from quotaSnapshots is stored here.
 * Persisted to ~/.caco/usage.json for display across server restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface QuotaSnapshot {
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

const USAGE_FILE = join(homedir(), '.caco', 'usage.json');

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
    console.log(`[USAGE] Loaded from cache: ${cached.remainingPercentage}% remaining (from ${cached.updatedAt})`);
  } catch {
    // No cache file or invalid - that's fine
  }
}

/**
 * Update usage from an assistant.usage event
 */
export function updateUsage(quotaSnapshots: Record<string, QuotaSnapshot> | undefined): void {
  if (!quotaSnapshots) return;
  
  // Take the first quota snapshot (usually there's just one)
  const keys = Object.keys(quotaSnapshots);
  if (keys.length === 0) return;
  
  const snapshot = quotaSnapshots[keys[0]];
  currentUsage = {
    remainingPercentage: snapshot.remainingPercentage,
    resetDate: snapshot.resetDate,
    isUnlimited: snapshot.isUnlimitedEntitlement,
    updatedAt: new Date().toISOString(),
    fromCache: false
  };
  
  console.log(`[USAGE] Updated: ${snapshot.remainingPercentage}% remaining`);
  
  // Persist to disk
  try {
    mkdirSync(join(homedir(), '.caco'), { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(currentUsage, null, 2));
  } catch (err) {
    console.error('[USAGE] Failed to persist:', err);
  }
}

/**
 * Get current usage info
 */
export function getUsage(): UsageInfo | null {
  return currentUsage;
}
