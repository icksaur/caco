/**
 * Activity box management
 */

import type { ToolEventData } from './types.js';

/**
 * Add activity item to activity box
 */
export function addActivityItem(type: string, text: string, details: string | null = null): void {
  const activityBox = document.querySelector('#pending-response .activity-box');
  if (!activityBox) return;
  
  const item = document.createElement('div');
  item.className = `activity-item ${type}`;
  
  if (details) {
    // Create expandable item with details
    const summary = document.createElement('div');
    summary.className = 'activity-summary';
    summary.textContent = text;
    summary.onclick = () => item.classList.toggle('expanded');
    item.appendChild(summary);
    
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'activity-details';
    detailsDiv.textContent = details;
    item.appendChild(detailsDiv);
  } else {
    item.textContent = text;
  }
  
  activityBox.appendChild(item);
  
  // Update activity count in header
  const wrapper = activityBox.closest('.activity-wrapper');
  if (wrapper) {
    const count = activityBox.querySelectorAll('.activity-item').length;
    const countSpan = wrapper.querySelector('.activity-count');
    if (countSpan) countSpan.textContent = `(${count})`;
  }
  
  // Auto-scroll activity box
  activityBox.scrollTop = activityBox.scrollHeight;
}

/**
 * Toggle activity box expand/collapse
 */
export function toggleActivityBox(header: HTMLElement): void {
  const wrapper = header.closest('.activity-wrapper');
  if (!wrapper) return;
  
  const isCollapsed = wrapper.classList.contains('collapsed');
  wrapper.classList.toggle('collapsed');
  
  // Update icon
  const icon = header.querySelector('.activity-icon');
  if (icon) {
    icon.textContent = isCollapsed ? '▼' : '▶';
  }
}

/**
 * Format tool arguments for display
 */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      // Truncate long strings
      const display = value.length > 80 ? value.substring(0, 80) + '...' : value;
      parts.push(`${key}: ${display}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}: ${JSON.stringify(value).substring(0, 60)}...`);
    } else {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join(', ');
}

/**
 * Format tool result for display
 */
export function formatToolResult(result: ToolEventData['result']): string {
  if (!result) return '';
  
  if (result.content) {
    const content = typeof result.content === 'string' 
      ? result.content 
      : JSON.stringify(result.content);
    return content.length > 500 ? content.substring(0, 500) + '...' : content;
  }
  
  return JSON.stringify(result).substring(0, 200);
}
