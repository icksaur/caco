/**
 * Git Diff applet — V6: conditional redirect stub.
 *
 * When a session exists, redirect to the unified `files` applet
 * (which now supports diffMode=unstaged|staged|range and diffRef).
 * Otherwise fall through to the standalone behavior so direct
 * deep-link URLs without a session still render.
 *
 * See docs/files-applet-v6.md §4.5 / §7.
 */

(function() {
  var api = window.appletAPI;
  if (api && typeof api.getSessionId === 'function' && api.getSessionId()) {
    var p = new URLSearchParams(window.location.search);
    var repoPath = p.get('path') || '';
    var file = p.get('file') || '';
    var staged = p.get('staged') === '1' || p.get('staged') === 'true';
    var ref = p.get('ref') || '';

    // Pass-through any params we don't recognize.
    var target = new URLSearchParams(p);
    target.delete('path');
    target.delete('file');
    target.delete('staged');
    target.delete('ref');

    if (!file && ref) {
      // Multi-file ref-range — V6 routes this to git-status with
      // the repo path preserved (the files applet is per-file).
      target.set('applet', 'git-status');
      if (repoPath) target.set('path', repoPath);
    } else {
      target.set('applet', 'files');
      if (file) {
        // joinPath equivalent inline (avoid sharing across applets).
        var trimmedBase = repoPath.replace(/[\/\\]+$/, '');
        var trimmedRel = file.replace(/^[\/\\]+/, '');
        var sep = trimmedBase.indexOf('\\') >= 0 && trimmedBase.indexOf('/') < 0
          ? '\\' : '/';
        target.set('openPath', trimmedBase ? (trimmedBase + sep + trimmedRel) : trimmedRel);
      }
      if (ref) {
        target.set('diffMode', 'range');
        target.set('diffRef', ref);
      } else if (staged) {
        target.set('diffMode', 'staged');
      }
    }

    var url = '?' + target.toString();
    if (window.navigation && typeof window.navigation.navigate === 'function') {
      try { window.navigation.navigate(url); return; } catch (_e) { /* fall through */ }
    }
    window.location.href = '/' + url;
    return;
  }

  // === No session: fall through to the standalone behavior. ===
/**
 * Git Diff Applet - View file diffs
 * 
 * URL params:
 *   ?path=/path/to/repo - Repository path (required)
 *   ?file=relative/path - File path relative to repo (for single-file diff)
 *   ?staged=1 - Show staged diff (default: unstaged)
 *   ?ref=HEAD~1..HEAD - Show diff for a ref range (overrides file/staged)
 */

// Params from URL
let repoPath = '';
let filePath = '';
let isStaged = false;
let refRange = '';

// DOM elements
const backBtn = document.getElementById('backBtn');
const fileName = document.getElementById('fileName');
const diffType = document.getElementById('diffType');
const refreshBtn = document.getElementById('refreshBtn');
const errorMessage = document.getElementById('errorMessage');
const noParamsMessage = document.getElementById('noParamsMessage');
const noDiffMessage = document.getElementById('noDiffMessage');
const diffContent = document.getElementById('diffContent');

/**
 * Run a git command via /api/shell
 */
async function runGit(args) {
  const response = await fetch('/api/shell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'git', args, cwd: repoPath })
  });
  return response.json();
}

/**
 * Show error message
 */
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

/**
 * Hide error message
 */
function hideError() {
  errorMessage.classList.add('hidden');
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/**
 * Render diff with syntax highlighting
 */
function renderDiff(diffText) {
  if (!diffText.trim()) {
    noDiffMessage.classList.remove('hidden');
    diffContent.classList.add('hidden');
    return;
  }
  
  noDiffMessage.classList.add('hidden');
  diffContent.classList.remove('hidden');
  
  const lines = diffText.split('\n');
  const htmlLines = lines.map(line => {
    const escaped = escapeHtml(line);
    
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<span class="diff-file">${escaped}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="diff-hunk">${escaped}</span>`;
    } else if (line.startsWith('+')) {
      return `<span class="diff-add">${escaped}</span>`;
    } else if (line.startsWith('-')) {
      return `<span class="diff-del">${escaped}</span>`;
    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="diff-meta">${escaped}</span>`;
    }
    return escaped;
  });
  
  diffContent.innerHTML = htmlLines.join('\n');
}

/**
 * Fetch and display diff
 */
async function refresh() {
  refreshBtn.classList.add('spinning');
  hideError();
  
  try {
    let args;
    
    if (refRange) {
      args = ['diff', refRange];
    } else {
      args = ['diff'];
      if (isStaged) args.push('--cached');
      args.push('--', filePath);
    }
    
    const result = await runGit(args);
    
    if (result.code !== 0) {
      if (result.stderr.includes('not a git repository')) {
        showError('Not a git repository');
      } else if (result.stderr.includes('bad revision')) {
        showError('Revision not found — this may be the initial commit');
      } else {
        showError(result.stderr || 'Git error');
      }
      return;
    }
    
    renderDiff(result.stdout);
    
  } catch (error) {
    showError('Failed to get diff: ' + error.message);
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

/**
 * Navigate back to git-status
 */
function goBack() {
  // Navigate to git-status with same repo path
  const url = new URL(window.location.href);
  url.searchParams.set('applet', 'git-status');
  url.searchParams.delete('file');
  url.searchParams.delete('staged');
  window.location.href = url.toString();
}

// Event listeners
backBtn.addEventListener('click', goBack);
refreshBtn.addEventListener('click', refresh);

// Handle initial load + URL param changes
window.appletAPI.onUrlParamsChange((params) => {
  const newPath = params.path || '';
  const newFile = params.file || '';
  const newStaged = params.staged === '1' || params.staged === 'true';
  const newRef = params.ref || '';
  
  if (newPath !== repoPath || newFile !== filePath || newStaged !== isStaged || newRef !== refRange) {
    repoPath = newPath;
    filePath = newFile;
    isStaged = newStaged;
    refRange = newRef;
    
    if (!repoPath) {
      noParamsMessage.classList.remove('hidden');
      fileName.textContent = '—';
    } else if (refRange) {
      noParamsMessage.classList.add('hidden');
      fileName.textContent = refRange;
      diffType.textContent = '(commit range)';
      refresh();
    } else if (filePath) {
      noParamsMessage.classList.add('hidden');
      fileName.textContent = filePath;
      diffType.textContent = isStaged ? '(staged)' : '(unstaged)';
      refresh();
    } else {
      noParamsMessage.classList.remove('hidden');
      fileName.textContent = '—';
    }
  }
});
})();
