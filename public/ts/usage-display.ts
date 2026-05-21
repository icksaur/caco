/**
 * Usage Display
 *
 * Renders Copilot quota into every element with class `.usage-display`.
 * Two such elements exist today: `#usageInfo` in the session-list view
 * and `.usage-display` in the meta-context footer.
 *
 * Refresh triggers (registered in init):
 * - Page load / WS reconnect (one fetch from /api/usage).
 * - Server-pushed `caco.usage` global event (no fetch; data inline).
 * - SDK `session.idle` event (belt-and-suspenders fetch).
 * - Explicit refresh() callers (e.g. when session-list view opens).
 */

import { formatAge } from './ui-utils.js';
import { onGlobalEvent, onEvent } from './websocket.js';

interface UsageInfo {
  remainingPercentage: number;
  resetDate?: string;
  isUnlimited: boolean;
  updatedAt: string;
  fromCache?: boolean;
}

let lastUsage: UsageInfo | null = null;

function targets(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.usage-display'));
}

function format(usage: UsageInfo, variant: 'long' | 'short'): string {
  if (usage.isUnlimited) {
    let text = variant === 'short' ? 'Unlimited' : 'Unlimited usage';
    if (usage.fromCache) text += ` (last fetched ${formatAge(usage.updatedAt, true)})`;
    return text;
  }
  const remaining = Math.round(usage.remainingPercentage);
  let text = variant === 'short' ? `${remaining}% remaining` : `${remaining}% of budget remaining`;
  if (usage.fromCache) text += ` (last fetched ${formatAge(usage.updatedAt, true)})`;
  return text;
}

function applyVariantClasses(el: HTMLElement, usage: UsageInfo | null): void {
  el.classList.remove('usage-low', 'usage-critical');
  if (!usage || usage.isUnlimited) return;
  const remaining = Math.round(usage.remainingPercentage);
  if (remaining <= 10) el.classList.add('usage-critical');
  else if (remaining <= 25) el.classList.add('usage-low');
}

function paint(usage: UsageInfo | null): void {
  lastUsage = usage;
  for (const el of targets()) {
    if (!usage) {
      el.textContent = '';
      applyVariantClasses(el, null);
      continue;
    }
    const variant = el.dataset.usageDisplay === 'footer' ? 'short' : 'long';
    el.textContent = format(usage, variant);
    applyVariantClasses(el, usage);
  }
}

/**
 * Repaint any newly-added `.usage-display` elements using the last seen value.
 * Cheap; callers can invoke after DOM changes that add usage targets.
 */
export function repaintUsageDisplays(): void {
  paint(lastUsage);
}

/**
 * Force a fetch from /api/usage and repaint. Used on page load, WS reconnect,
 * and explicit triggers like opening the session-list view.
 */
export async function refreshUsageDisplays(): Promise<void> {
  try {
    const response = await fetch('/api/usage');
    if (!response.ok) return;
    const data = await response.json();
    paint((data?.usage as UsageInfo | null) ?? null);
  } catch (err) {
    console.error('[usage] Failed to refresh:', err);
  }
}

let inited = false;

/**
 * Wire up the live update channels. Idempotent.
 */
export function initUsageDisplays(): void {
  if (inited) return;
  inited = true;

  onGlobalEvent((event) => {
    if (event.type === 'caco.usage') {
      paint((event.data as unknown as UsageInfo) ?? null);
    }
  });

  onEvent((event) => {
    if (event.type === 'session.idle') {
      void refreshUsageDisplays();
    }
  });

  void refreshUsageDisplays();
}
