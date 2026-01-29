/**
 * Usage State
 * 
 * Tracks quota/budget usage from SDK's assistant.usage events.
 * The remainingPercentage from quotaSnapshots is stored here.
 */

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
}

// Global usage state (most recent from any session)
let currentUsage: UsageInfo | null = null;

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
    updatedAt: new Date().toISOString()
  };
  
  console.log(`[USAGE] Updated: ${snapshot.remainingPercentage}% remaining`);
}

/**
 * Get current usage info
 */
export function getUsage(): UsageInfo | null {
  return currentUsage;
}
