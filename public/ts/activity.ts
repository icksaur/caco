/**
 * Activity box management
 */

import type { ToolEventData } from './types.js';
import { scrollToBottom } from './ui-utils.js';

/**
 * Ensure an activity box exists for the current activity phase
 * Creates a new activity-wrapper if the last one has been "closed" by chat content
 */
function ensurePendingResponse(): Element | null {
  const pendingResponse = document.getElementById('pending-response');
  
  // If no pending response at all, create initial bubble
  if (!pendingResponse) {
    const chat = document.getElementById('chat');
    if (!chat) return null;
    
    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant pending';
    assistantDiv.id = 'pending-response';
    assistantDiv.setAttribute('data-markdown', '');
    assistantDiv.setAttribute('data-message-id', `pending_${Date.now()}`);
    
    // Create first activity wrapper
    const activityWrapper = createActivityWrapper();
    assistantDiv.appendChild(activityWrapper);
    
    chat.appendChild(assistantDiv);
    scrollToBottom();
    
    return activityWrapper.querySelector('.activity-box');
  }
  
  // Pending response exists - check if we need a new activity wrapper
  // If the last element is markdown-content, we need a new activity block
  const lastChild = pendingResponse.lastElementChild;
  if (lastChild && (lastChild.classList.contains('markdown-content') || lastChild.classList.contains('outputs-container'))) {
    // Append new activity wrapper after chat content
    const activityWrapper = createActivityWrapper();
    pendingResponse.appendChild(activityWrapper);
    scrollToBottom();
    return activityWrapper.querySelector('.activity-box');
  }
  
  // Last element is already an activity-wrapper, reuse it
  const activityBox = pendingResponse.querySelector('.activity-wrapper:last-child .activity-box');
  return activityBox;
}

/**
 * Create a new activity wrapper element
 */
function createActivityWrapper(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'activity-wrapper';
  wrapper.innerHTML = `
    <div class="activity-header" onclick="toggleActivityBox(this)">
      <span class="activity-icon">▼</span>
      <span class="activity-label">Activity</span>
      <span class="activity-count"></span>
    </div>
    <div class="activity-box"></div>
  `;
  return wrapper;
}

/**
 * Add activity item to activity box
 */
export function addActivityItem(type: string, text: string, details: string | null = null): void {
  const activityBox = ensurePendingResponse();
  if (!activityBox) return;
  
  // Special handling for reasoning-delta: append to existing reasoning item
  if (type === 'reasoning-delta') {
    const lastItem = activityBox.querySelector('.activity-item.reasoning:last-of-type');
    if (lastItem) {
      const detailsDiv = lastItem.querySelector('.activity-details');
      if (detailsDiv) {
        detailsDiv.textContent = (detailsDiv.textContent || '') + text;
        // Auto-scroll activity box
        activityBox.scrollTop = activityBox.scrollHeight;
        scrollToBottom();
        return;
      }
    }
    // If no existing reasoning item, create one
    type = 'reasoning';
    text = '🤔 Thinking';
    details = text; // Use the delta as initial details
  }
  
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
