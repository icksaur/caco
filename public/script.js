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
  }
}

// Test clipboard access on page load
console.log('Clipboard API available:', 'clipboard' in navigator);
console.log('Page loaded and ready for paste');
