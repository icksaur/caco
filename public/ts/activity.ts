/**
 * Activity box management
 */

import type { ToolEventData } from './types.js';
import { scrollToBottom } from './ui-utils.js';

/**
 * Ensure pending response exists for activity items
 * Creates one if it doesn't exist (activity can arrive before first delta)
 */
function ensurePendingResponse(): Element | null {
  let activityBox = document.querySelector('#pending-response .activity-box');
  if (activityBox) return activityBox;
  
  // Create pending response bubble for activity
  const chat = document.getElementById('chat');
  if (!chat) return null;
  
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant pending';
  assistantDiv.id = 'pending-response';
  assistantDiv.setAttribute('data-markdown', '');
  assistantDiv.setAttribute('data-message-id', `pending_${Date.now()}`);
  assistantDiv.innerHTML = `
    <div class="activity-wrapper">
      <div class="activity-header" onclick="toggleActivityBox(this)">
        <span class="activity-icon">▼</span>
        <span class="activity-label">Activity</span>
        <span class="activity-count"></span>
      </div>
      <div class="activity-box"></div>
    </div>
    <div class="outputs-container"></div>
    <div class="markdown-content streaming-cursor"></div>
  `;
  chat.appendChild(assistantDiv);
  
  return assistantDiv.querySelector('.activity-box');
}

/**
 * Add activity item to activity box
 */
export function addActivityItem(type: string, text: string, details: string | null = null): void {
  const activityBox = ensurePendingResponse();
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
  
  // Auto-scroll activity box itself
  activityBox.scrollTop = activityBox.scrollHeight;
  
  // Scroll chat to keep up with activity growth
  scrollToBottom();
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
