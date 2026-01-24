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
        // Scroll to bottom
        const main = document.querySelector('main');
        main.scrollTop = main.scrollHeight;
      }
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadSessionInfo();
  loadHistory();
});

// Toggle session panel
function toggleSessionPanel() {
  const chat = document.getElementById('chat');
  const panel = document.getElementById('sessionPanel');
  const btn = document.querySelector('.hamburger-btn');
  
  const isOpen = panel.classList.contains('visible');
  
  if (isOpen) {
    // Close panel, show chat
    panel.classList.remove('visible');
    chat.classList.remove('hidden');
    btn.classList.remove('active');
  } else {
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
        item.onclick = () => switchSession(session.sessionId);
        
        // Summary text (truncated)
        const summary = session.summary || 'No summary';
        const age = session.updatedAt ? ` (${formatAge(session.updatedAt)})` : '';
        item.textContent = summary + age;
        
        container.appendChild(item);
      }
    }
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

// Switch to a different session
async function switchSession(sessionId) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    });
    
    if (response.ok) {
      // Reload the page to get new session's history
      window.location.reload();
    } else {
      const err = await response.json();
      alert('Failed to switch session: ' + err.error);
    }
  } catch (error) {
    console.error('Failed to switch session:', error);
  }
}

// Test clipboard access on page load
console.log('Clipboard API available:', 'clipboard' in navigator);
console.log('Page loaded and ready for paste');
