// Scroll to bottom when new messages arrive
document.body.addEventListener('htmx:afterSwap', () => {
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
});

// Handle image paste - with debugging
document.addEventListener('paste', (e) => {
  console.log('Paste event fired!', e);
  
  const items = e.clipboardData?.items;
  console.log('Clipboard items:', items);
  
  if (!items) {
    console.log('No clipboard items found');
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`Item ${i}:`, item.type, item.kind);
    
    if (item.type.indexOf('image') !== -1) {
      console.log('Image found!');
      e.preventDefault();
      const blob = item.getAsFile();
      console.log('Blob:', blob);
      
      const reader = new FileReader();
      
      reader.onload = (event) => {
        const base64 = event.target.result;
        console.log('Base64 length:', base64.length);
        document.getElementById('imageData').value = base64;
        document.getElementById('previewImg').src = base64;
        document.getElementById('imagePreview').classList.add('visible');
      };
      
      reader.onerror = (error) => {
        console.error('FileReader error:', error);
      };
      
      reader.readAsDataURL(blob);
      break;
    }
  }
});

// Remove attached image
function removeImage() {
  document.getElementById('imageData').value = '';
  document.getElementById('previewImg').src = '';
  document.getElementById('imagePreview').classList.remove('visible');
}

// Scroll chat to bottom
function scrollToBottom() {
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
}

// Load conversation history on page load
async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (response.ok) {
      const html = await response.text();
      if (html.trim()) {
        document.getElementById('chat').innerHTML = html;
        // Render any markdown in loaded messages
        if (typeof renderMarkdown === 'function') {
          renderMarkdown();
        }
      }
      // Always scroll to bottom after loading history
      scrollToBottom();
    }
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

// Load session info
async function loadSessionInfo() {
  try {
    const response = await fetch('/api/session');
    if (response.ok) {
      const info = await response.json();
      console.log('Session:', info.sessionId);
      console.log('CWD:', info.cwd);
    }
  } catch (error) {
    console.error('Failed to load session info:', error);
  }
}

// Load and apply user preferences
async function loadPreferences() {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs = await response.json();
      
      // Apply saved model selection
      if (prefs.lastModel && CURATED_MODELS.find(m => m.id === prefs.lastModel)) {
        selectedModel = prefs.lastModel;
        document.getElementById('selectedModel').value = selectedModel;
        
        // Update placeholder
        const modelInfo = CURATED_MODELS.find(m => m.id === selectedModel);
        if (modelInfo) {
          document.querySelector('input[name="message"]').placeholder = `Ask ${modelInfo.name}...`;
        }
      }
      
      // Store last cwd for new chat form
      if (prefs.lastCwd) {
        currentServerCwd = prefs.lastCwd;
      }
      
      console.log('Preferences loaded:', prefs);
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
}

// Save a preference
async function savePreference(key, value) {
  try {
    await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    });
  } catch (error) {
    console.error('Failed to save preference:', error);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadSessionInfo();
  loadPreferences();
  loadHistory();
});

// Toggle session panel
function toggleSessionPanel() {
  const chat = document.getElementById('chat');
  const panel = document.getElementById('sessionPanel');
  const modelPanel = document.getElementById('modelPanel');
  const btn = document.querySelector('.hamburger-btn:not(.model-btn)');
  const modelBtn = document.querySelector('.hamburger-btn.model-btn');
  
  const isOpen = panel.classList.contains('visible');
  
  if (isOpen) {
    // Close panel, show chat
    panel.classList.remove('visible');
    chat.classList.remove('hidden');
    btn.classList.remove('active');
  } else {
    // Close model panel if open
    modelPanel.classList.remove('visible');
    modelBtn.classList.remove('active');
    // Open panel, hide chat
    panel.classList.add('visible');
    chat.classList.add('hidden');
    btn.classList.add('active');
    // Load sessions when opening
    loadSessions();
  }
}

// Format relative time
function formatAge(dateStr) {
  if (!dateStr) return '';
  
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  
  if (years >= 1) return `${years} year${years > 1 ? 's' : ''}`;
  if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
  if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes >= 1) return `${minutes} min`;
  return 'just now';
}

// Load and render sessions
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;
    
    const data = await response.json();
    const { activeSessionId, currentCwd, grouped } = data;
    
    // Store for use in switchSession and new chat form
    currentServerCwd = currentCwd;
    currentActiveSessionId = activeSessionId;
    
    const container = document.getElementById('sessionList');
    container.innerHTML = '';
    
    // Sort cwds: current first, then alphabetically
    const cwds = Object.keys(grouped).sort((a, b) => {
      if (a === currentCwd) return -1;
      if (b === currentCwd) return 1;
      return a.localeCompare(b);
    });
    
    for (const cwd of cwds) {
      const sessions = grouped[cwd];
      
      // Handle unknown cwd sessions - just show a summary
      if (cwd === '(unknown)' || !cwd) {
        const summary = document.createElement('div');
        summary.className = 'cwd-header omitted';
        summary.textContent = `no cwd (${sessions.length} omitted)`;
        container.appendChild(summary);
        continue;
      }
      
      // CWD header
      const cwdHeader = document.createElement('div');
      cwdHeader.className = 'cwd-header';
      cwdHeader.textContent = cwd === currentCwd ? `${cwd} (current)` : cwd;
      container.appendChild(cwdHeader);
      
      // Session items
      for (const session of sessions) {
        const item = document.createElement('div');
        item.className = 'session-item';
        if (session.sessionId === activeSessionId) {
          item.classList.add('active');
        }
        item.dataset.sessionId = session.sessionId;
        
        // Summary text (truncated)
        const summarySpan = document.createElement('span');
        summarySpan.className = 'session-summary';
        const summary = session.summary || 'No summary';
        const age = session.updatedAt ? ` (${formatAge(session.updatedAt)})` : '';
        summarySpan.textContent = summary + age;
        summarySpan.onclick = () => switchSession(session.sessionId);
        item.appendChild(summarySpan);
        
        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'session-delete';
        deleteBtn.textContent = '×';
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          deleteSession(session.sessionId, session.summary);
        };
        item.appendChild(deleteBtn);
        
        container.appendChild(item);
      }
    }
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

// Switch to a different session
async function switchSession(sessionId) {
  // If already on this session, just close the panel and scroll to bottom
  if (sessionId === currentActiveSessionId) {
    toggleSessionPanel();
    scrollToBottom();
    return;
  }
  
  // Show loading state on clicked item
  const clickedItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (clickedItem) {
    clickedItem.classList.add('loading');
  }
  
  try {
    const response = await fetch(`/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    });
    
    if (response.ok) {
      // Reload the page to get new session's history
      window.location.reload();
    } else {
      const err = await response.json();
      if (clickedItem) clickedItem.classList.remove('loading');
      alert('Failed to switch session: ' + err.error);
    }
  } catch (error) {
    console.error('Failed to switch session:', error);
    if (clickedItem) clickedItem.classList.remove('loading');
  }
}

// Delete a session
async function deleteSession(sessionId, summary) {
  const displayName = summary || sessionId.slice(0, 8);
  if (!confirm(`Delete session "${displayName}"?\n\nThis cannot be undone.`)) {
    return;
  }
  
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // If we deleted the active session, clear the chat
      if (data.wasActive) {
        document.getElementById('chat').innerHTML = '';
      }
      
      // Refresh session list
      loadSessions();
    } else {
      const err = await response.json();
      alert('Failed to delete session: ' + err.error);
    }
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + error.message);
  }
}

// Store current cwd and session for new chat form and session switching
let currentServerCwd = '';
let currentActiveSessionId = null;

// Toggle new chat form expansion
function toggleNewChatForm() {
  const form = document.getElementById('newChatForm');
  const pathInput = document.getElementById('newChatPath');
  const errorDiv = document.getElementById('newChatError');
  
  if (form.classList.contains('expanded')) {
    // Collapse
    form.classList.remove('expanded');
    errorDiv.classList.remove('visible');
    errorDiv.textContent = '';
  } else {
    // Expand and pre-fill with current cwd
    form.classList.add('expanded');
    pathInput.value = currentServerCwd;
    pathInput.focus();
    pathInput.select();
  }
}

// Create a new session with specified cwd
async function createNewSession() {
  const pathInput = document.getElementById('newChatPath');
  const errorDiv = document.getElementById('newChatError');
  const cwd = pathInput.value.trim();
  
  if (!cwd) {
    errorDiv.textContent = 'Please enter a working directory path';
    errorDiv.classList.add('visible');
    return;
  }
  
  try {
    const response = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd })
    });
    
    if (response.ok) {
      // Reload the page to start fresh session
      window.location.reload();
    } else {
      const err = await response.json();
      errorDiv.textContent = err.error || 'Failed to create session';
      errorDiv.classList.add('visible');
    }
  } catch (error) {
    console.error('Failed to create session:', error);
    errorDiv.textContent = 'Failed to create session: ' + error.message;
    errorDiv.classList.add('visible');
  }
}

// Test clipboard access on page load
console.log('Clipboard API available:', 'clipboard' in navigator);
console.log('Page loaded and ready for paste');

// Current selected model
let selectedModel = 'claude-sonnet-4';

// Toggle model panel
function toggleModelPanel() {
  const chat = document.getElementById('chat');
  const sessionPanel = document.getElementById('sessionPanel');
  const modelPanel = document.getElementById('modelPanel');
  const modelBtn = document.querySelector('.hamburger-btn.model-btn');
  const sessionBtn = document.querySelector('.hamburger-btn:not(.model-btn)');
  
  const isOpen = modelPanel.classList.contains('visible');
  
  if (isOpen) {
    // Close panel, show chat
    modelPanel.classList.remove('visible');
    chat.classList.remove('hidden');
    modelBtn.classList.remove('active');
  } else {
    // Close session panel if open
    sessionPanel.classList.remove('visible');
    sessionBtn.classList.remove('active');
    // Open model panel, hide chat
    modelPanel.classList.add('visible');
    chat.classList.add('hidden');
    modelBtn.classList.add('active');
    // Load models when opening
    loadModels();
  }
}

// Curated model list with display names and costs
const CURATED_MODELS = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', cost: 1 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', cost: 3 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', cost: 0.33 },
  { id: 'gpt-4.1', name: 'GPT-4.1', cost: 0 },
  { id: 'gpt-4o', name: 'GPT-4o', cost: 0 },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', cost: 0 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', cost: 1 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', cost: 0.33 }
];

// Load and render models
async function loadModels() {
  const container = document.getElementById('modelList');
  container.innerHTML = '';
  
  for (const model of CURATED_MODELS) {
    const item = document.createElement('div');
    item.className = 'model-item';
    if (model.id === selectedModel) {
      item.classList.add('active');
    }
    item.dataset.modelId = model.id;
    item.onclick = () => selectModel(model.id);
    
    // Model name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'model-name';
    nameSpan.textContent = model.name;
    item.appendChild(nameSpan);
    
    // Cost indicator
    const costSpan = document.createElement('span');
    costSpan.className = 'model-cost';
    if (model.cost === 0) {
      costSpan.textContent = 'free';
      costSpan.classList.add('free');
    } else if (model.cost < 1) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('cheap');
    } else if (model.cost > 1) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('expensive');
    } else {
      costSpan.textContent = '1x';
    }
    item.appendChild(costSpan);
    
    container.appendChild(item);
  }
}

// Select a model
function selectModel(modelId) {
  selectedModel = modelId;
  document.getElementById('selectedModel').value = modelId;
  
  // Update placeholder to show selected model
  const modelInfo = CURATED_MODELS.find(m => m.id === modelId);
  const input = document.querySelector('input[name="message"]');
  input.placeholder = `Ask ${modelInfo?.name || modelId}...`;
  
  // Save preference
  savePreference('lastModel', modelId);
  
  // Close panel
  toggleModelPanel();
}

// ========================================
// Streaming Implementation
// ========================================

// HTML escape helper
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Add user message bubble immediately
function addUserBubble(message, hasImage) {
  const chat = document.getElementById('chat');
  const imageIndicator = hasImage ? ' [img]' : '';
  
  // Add user message
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.innerHTML = `${escapeHtml(message)}${hasImage ? ' <span class="image-indicator">[img]</span>' : ''}`;
  chat.appendChild(userDiv);
  
  // Add pending response with activity box
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant pending';
  assistantDiv.id = 'pending-response';
  assistantDiv.setAttribute('data-markdown', '');
  assistantDiv.innerHTML = `
    <div class="activity-wrapper">
      <div class="activity-header" onclick="toggleActivityBox(this)">
        <span class="activity-icon">▶</span>
        <span class="activity-label">Activity</span>
        <span class="activity-count"></span>
      </div>
      <div class="activity-box"></div>
    </div>
    <div class="markdown-content streaming-cursor"></div>
  `;
  chat.appendChild(assistantDiv);
  
  // Scroll to bottom
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
  
  return assistantDiv;
}

// Add activity item to activity box
function addActivityItem(type, text, details = null) {
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

// Format tool arguments for display
function formatToolArgs(args) {
  if (!args) return '';
  
  // Handle common tool argument patterns
  const parts = [];
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

// Format tool result for display
function formatToolResult(result) {
  if (!result) return '';
  
  if (result.content) {
    // Truncate content to reasonable size
    const content = typeof result.content === 'string' 
      ? result.content 
      : JSON.stringify(result.content);
    return content.length > 500 ? content.substring(0, 500) + '...' : content;
  }
  
  return JSON.stringify(result).substring(0, 200);
}

// Toggle activity box expand/collapse
function toggleActivityBox(header) {
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

// Track active EventSource for stop functionality
let activeEventSource = null;
let stopButtonTimeout = null;

// Stream response via EventSource
function streamResponse(prompt, model, imageData) {
  // Build URL with parameters
  const params = new URLSearchParams({ prompt, model });
  if (imageData) {
    params.set('imageData', imageData);
  }
  
  const eventSource = new EventSource(`/api/stream?${params.toString()}`);
  activeEventSource = eventSource;
  
  const activityBox = document.querySelector('#pending-response .activity-box');
  const responseDiv = document.querySelector('#pending-response .markdown-content');
  let responseContent = '';
  let firstDeltaReceived = false;
  
  // Handle response text deltas
  eventSource.addEventListener('assistant.message_delta', (e) => {
    const data = JSON.parse(e.data);
    if (data.deltaContent) {
      responseContent += data.deltaContent;
      responseDiv.textContent = responseContent;
      
      // Collapse activity wrapper on first delta
      if (!firstDeltaReceived) {
        const wrapper = document.querySelector('#pending-response .activity-wrapper');
        if (wrapper) {
          wrapper.classList.add('collapsed');
          const icon = wrapper.querySelector('.activity-icon');
          if (icon) icon.textContent = '▶';
        }
        firstDeltaReceived = true;
      }
      
      // Scroll to bottom
      const main = document.querySelector('main');
      main.scrollTop = main.scrollHeight;
    }
  });
  
  // Handle final message
  eventSource.addEventListener('assistant.message', (e) => {
    const data = JSON.parse(e.data);
    if (data.content) {
      // Set final content as text (renderMarkdown will parse it)
      responseDiv.textContent = data.content;
      responseDiv.classList.remove('streaming-cursor');
      
      // Mark as not processed so renderMarkdown will handle it
      const pending = document.getElementById('pending-response');
      if (pending) {
        pending.dataset.markdownProcessed = 'false';
      }
      
      // Render markdown (with DOMPurify sanitization)
      if (typeof renderMarkdown === 'function') {
        renderMarkdown();
      }
    }
  });
  
  // Handle turn start
  eventSource.addEventListener('assistant.turn_start', (e) => {
    const data = JSON.parse(e.data);
    addActivityItem('turn', `Turn ${parseInt(data.turnId || 0) + 1}...`);
  });
  
  // Handle intent
  eventSource.addEventListener('assistant.intent', (e) => {
    const data = JSON.parse(e.data);
    if (data.intent) {
      addActivityItem('intent', `Intent: ${data.intent}`);
    }
  });
  
  // Handle reasoning
  eventSource.addEventListener('assistant.reasoning_delta', (e) => {
    // Could show reasoning, but might be verbose
    // Just indicate reasoning is happening
  });
  
  // Handle tool execution
  eventSource.addEventListener('tool.execution_start', (e) => {
    const data = JSON.parse(e.data);
    const toolName = data.toolName || data.name || 'tool';
    const args = formatToolArgs(data.arguments);
    const summary = `▶ ${toolName}`;
    const details = args ? `Arguments: ${args}` : null;
    addActivityItem('tool', summary, details);
  });
  
  eventSource.addEventListener('tool.execution_complete', (e) => {
    const data = JSON.parse(e.data);
    const toolName = data.toolName || data.name || 'tool';
    const status = data.success ? '✓' : '✗';
    const summary = `${status} ${toolName}`;
    const details = data.result ? formatToolResult(data.result) : null;
    addActivityItem('tool-result', summary, details);
  });
  
  // Handle errors
  eventSource.addEventListener('session.error', (e) => {
    const data = JSON.parse(e.data);
    addActivityItem('error', `Error: ${data.message || 'Unknown error'}`);
  });
  
  eventSource.addEventListener('error', (e) => {
    const data = JSON.parse(e.data || '{}');
    addActivityItem('error', `Error: ${data.message || 'Connection error'}`);
  });
  
  // Handle completion
  eventSource.addEventListener('done', () => {
    eventSource.close();
    activeEventSource = null;
    finishPendingResponse();
  });
  
  eventSource.addEventListener('session.idle', () => {
    // Will also receive 'done', but handle just in case
  });
  
  // Handle connection errors
  eventSource.onerror = (err) => {
    console.error('EventSource error:', err);
    eventSource.close();
    activeEventSource = null;
    
    // If we haven't received any content, show error
    if (!responseContent && !firstDeltaReceived) {
      addActivityItem('error', 'Connection lost');
    }
    
    finishPendingResponse();
  };
}

// Stop streaming response
function stopStreaming() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
    
    // Add visual feedback
    addActivityItem('info', 'Stopped by user');
    
    // Mark response as stopped
    const responseDiv = document.querySelector('#pending-response .markdown-content');
    if (responseDiv) {
      responseDiv.classList.remove('streaming-cursor');
    }
    
    finishPendingResponse();
  }
}

// Clean up pending response
function finishPendingResponse() {
  const pending = document.getElementById('pending-response');
  if (pending) {
    pending.classList.remove('pending');
    pending.removeAttribute('id');
    
    // Remove streaming cursor
    const content = pending.querySelector('.markdown-content');
    if (content) {
      content.classList.remove('streaming-cursor');
    }
    
    // Collapse activity wrapper when done (user can re-expand)
    const wrapper = pending.querySelector('.activity-wrapper');
    if (wrapper) {
      wrapper.classList.add('collapsed');
      const icon = wrapper.querySelector('.activity-icon');
      if (icon) icon.textContent = '▶';
    }
  }
  
  // Re-enable form
  setFormEnabled(true);
}

// Enable/disable form during streaming
function setFormEnabled(enabled) {
  const form = document.getElementById('chatForm');
  const input = form.querySelector('input[name="message"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  
  // Clear any pending stop button timeout
  if (stopButtonTimeout) {
    clearTimeout(stopButtonTimeout);
    stopButtonTimeout = null;
  }
  
  input.disabled = !enabled;
  
  if (enabled) {
    // Restore to Send button
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    submitBtn.onclick = null;
    input.focus();
  } else {
    // Briefly disable to prevent double-tap, then show Stop
    submitBtn.disabled = true;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    
    stopButtonTimeout = setTimeout(() => {
      // Only show stop if still streaming
      if (activeEventSource) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Stop';
        submitBtn.classList.add('stop-btn');
        submitBtn.onclick = (e) => {
          e.preventDefault();
          stopStreaming();
        };
      }
    }, 400);
  }
}

// Handle form submission with streaming
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chatForm');
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const input = form.querySelector('input[name="message"]');
    const message = input.value.trim();
    const model = document.getElementById('selectedModel').value;
    const imageData = document.getElementById('imageData').value;
    
    if (!message) return;
    
    // Disable form during streaming
    setFormEnabled(false);
    
    // Add user bubble immediately
    const hasImage = !!imageData;
    addUserBubble(message, hasImage);
    
    // Clear input and image
    input.value = '';
    removeImage();
    
    // Start streaming
    streamResponse(message, model, imageData);
  });
});
