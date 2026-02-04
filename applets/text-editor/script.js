var currentFilePath = '';
var originalContent = '';
var isDirty = false;
var currentLanguage = 'plaintext';

var editor = document.getElementById('editor');
var saveBtn = document.getElementById('saveBtn');
var status = document.getElementById('status');
var filePathEl = document.getElementById('filePath');
var highlightCode = document.getElementById('highlightCode');
var highlightLayer = document.querySelector('.highlight-layer');

// Map file extensions to highlight.js language names
var extToLang = {
  js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', lua: 'lua', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  sql: 'sql', graphql: 'graphql',
  makefile: 'makefile', dockerfile: 'dockerfile',
  r: 'r', php: 'php', pl: 'perl'
};

function getLanguage(path) {
  if (!path) return 'plaintext';
  var ext = path.split('.').pop().toLowerCase();
  // Handle Makefile, Dockerfile without extension
  var basename = path.split('/').pop().toLowerCase();
  if (basename === 'makefile') return 'makefile';
  if (basename === 'dockerfile') return 'dockerfile';
  return extToLang[ext] || 'plaintext';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function updateHighlight() {
  var text = editor.value;
  // Always add trailing newline so cursor at end has space
  if (!text.endsWith('\n')) text += '\n';
  
  if (typeof hljs !== 'undefined' && currentLanguage !== 'plaintext') {
    try {
      var result = hljs.highlight(text, { language: currentLanguage, ignoreIllegals: true });
      highlightCode.innerHTML = result.value;
    } catch (e) {
      // Language not supported, fall back to plain text
      highlightCode.innerHTML = escapeHtml(text);
    }
  } else {
    highlightCode.innerHTML = escapeHtml(text);
  }
}

// Sync scroll between textarea and highlight layer
function syncScroll() {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
}

editor.addEventListener('scroll', syncScroll);

async function loadFile(path) {
  if (!path) {
    filePathEl.textContent = 'No file loaded';
    editor.value = '';
    editor.placeholder = 'Use: ?applet=text-editor&path=file.txt';
    updateHighlight();
    return;
  }
  
  filePathEl.textContent = path;
  status.textContent = 'Loading...';
  status.className = 'status';
  currentLanguage = getLanguage(path);
  
  try {
    var response = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    var text = await response.text();
    editor.value = text;
    originalContent = text;
    isDirty = false;
    saveBtn.disabled = true;
    saveBtn.classList.remove('dirty');
    status.textContent = text.length + ' chars • ' + currentLanguage;
    updateHighlight();
    
    window.appletAPI.setAppletState({ path: path, loaded: true, size: text.length, language: currentLanguage });
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'status error';
  }
}

editor.addEventListener('input', function() {
  isDirty = editor.value !== originalContent;
  saveBtn.disabled = !isDirty;
  if (isDirty) {
    saveBtn.classList.add('dirty');
    saveBtn.textContent = 'Save *';
  } else {
    saveBtn.classList.remove('dirty');
    saveBtn.textContent = 'Save';
  }
  updateHighlight();
});

saveBtn.addEventListener('click', async function() {
  if (!currentFilePath || !isDirty) return;
  
  saveBtn.disabled = true;
  status.textContent = 'Saving...';
  status.className = 'status';
  
  try {
    var response = await fetch('/api/files/' + encodeURIComponent(currentFilePath), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: editor.value
    });
    
    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || 'Save failed');
    }
    
    originalContent = editor.value;
    isDirty = false;
    saveBtn.textContent = 'Save';
    saveBtn.classList.remove('dirty');
    status.textContent = 'Saved!';
    status.className = 'status success';
    
    setTimeout(function() {
      status.textContent = editor.value.length + ' chars';
      status.className = 'status';
    }, 2000);
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'status error';
    saveBtn.disabled = false;
  }
});

// Handle Ctrl+S
editor.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (!saveBtn.disabled) saveBtn.click();
  }
});

// Handle initial load + URL param changes
window.appletAPI.onUrlParamsChange(function(params) {
  var newPath = params.path || '';
  if (newPath !== currentFilePath) {
    currentFilePath = newPath;
    loadFile(currentFilePath);
  }
});
