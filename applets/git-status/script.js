/**
 * Git Status Applet - Phases 1, 2, 4, 5: Status, Staging, Commit, Push/Pull
 * 
 * Uses /api/shell to run git commands and parse output.
 * 
 * URL params:
 *   ?path=/path/to/repo - Repository path (required)
 */

// Current repository path from URL
let repoPath = '';

// Current parsed status (for commit button state)
let currentStatus = { staged: [], unstaged: [], untracked: [] };

// DOM elements
const branchName = document.getElementById('branchName');
const errorMessage = document.getElementById('errorMessage');
const stagedFiles = document.getElementById('stagedFiles');
const unstagedFiles = document.getElementById('unstagedFiles');
const untrackedFiles = document.getElementById('untrackedFiles');
const stagedCount = document.getElementById('stagedCount');
const unstagedCount = document.getElementById('unstagedCount');
const untrackedCount = document.getElementById('untrackedCount');
const cleanMessage = document.getElementById('cleanMessage');
const refreshBtn = document.getElementById('refreshBtn');
const repoPathLabel = document.getElementById('repoPath');

// Phase 2 & 4 elements
const stageAllBtn = document.getElementById('stageAllBtn');
const unstageAllBtn = document.getElementById('unstageAllBtn');
const stageUntrackedBtn = document.getElementById('stageUntrackedBtn');
const commitMessage = document.getElementById('commitMessage');
const commitBtn = document.getElementById('commitBtn');
const commitSection = document.getElementById('commitSection');

// Phase 5 elements
const pushBtn = document.getElementById('pushBtn');
const pullBtn = document.getElementById('pullBtn');
const aheadBehind = document.getElementById('aheadBehind');

/**
 * Run a git command via /api/shell in the repo directory
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
 * Get current branch name
 */
async function getBranch() {
  const result = await runGit(['branch', '--show-current']);
  if (result.code === 0) {
    return result.stdout.trim() || 'HEAD detached';
  }
  return 'unknown';
}

/**
 * Parse git status --porcelain=v2 output
 * 
 * Format:
 *   1 XY ... path        - ordinary changed entry
 *   2 XY ... path\tpath  - renamed/copied entry
 *   ? path               - untracked
 *   ! path               - ignored
 * 
 * XY: X = index status, Y = worktree status
 *   M = modified, A = added, D = deleted, R = renamed, C = copied, . = unchanged
 */
function parseStatus(stdout) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  
  const lines = stdout.split('\n').filter(line => line.length > 0);
  
  for (const line of lines) {
    if (line.startsWith('?')) {
      // Untracked file
      const path = line.slice(2);
      untracked.push({ path, status: '?' });
    } else if (line.startsWith('!')) {
      // Ignored - skip
      continue;
    } else if (line.startsWith('1') || line.startsWith('2')) {
      // Changed entry: "1 XY ..." or "2 XY ..."
      const parts = line.split(' ');
      const xy = parts[1];
      const indexStatus = xy[0];
      const worktreeStatus = xy[1];
      
      // Get path (last element, may have tab for renames)
      let path;
      if (line.startsWith('2')) {
        // Rename: path is after last tab
        const tabIndex = line.lastIndexOf('\t');
        path = tabIndex > 0 ? line.slice(tabIndex + 1) : parts[parts.length - 1];
      } else {
        path = parts[parts.length - 1];
      }
      
      // Staged changes (index status != .)
      if (indexStatus !== '.') {
        staged.push({ path, status: indexStatus });
      }
      
      // Unstaged changes (worktree status != .)
      if (worktreeStatus !== '.') {
        unstaged.push({ path, status: worktreeStatus });
      }
    }
  }
  
  return { staged, unstaged, untracked };
}

/**
 * Get status icon for file status
 */
function getStatusIcon(status) {
  switch (status) {
    case 'M': return '✎';  // Modified
    case 'A': return '+';  // Added
    case 'D': return '−';  // Deleted
    case 'R': return '→';  // Renamed
    case 'C': return '⊕';  // Copied
    case '?': return '?';  // Untracked
    default: return '•';
  }
}

/**
 * Get status class for styling
 */
function getStatusClass(status) {
  switch (status) {
    case 'M': return 'status-modified';
    case 'A': return 'status-added';
    case 'D': return 'status-deleted';
    case 'R': return 'status-renamed';
    case '?': return 'status-untracked';
    default: return '';
  }
}

/**
 * Navigate to git-diff applet for a file
 */
function viewDiff(filePath, staged) {
  const url = new URL(window.location.href);
  url.searchParams.set('applet', 'git-diff');
  url.searchParams.set('file', filePath);
  if (staged) {
    url.searchParams.set('staged', '1');
  } else {
    url.searchParams.delete('staged');
  }
  window.location.href = url.toString();
}

/**
 * Render file list with action buttons
 */
function renderFileList(container, files, section) {
  container.innerHTML = '';
  
  for (const file of files) {
    const li = document.createElement('li');
    li.className = `file-item ${getStatusClass(file.status)}`;
    
    const icon = document.createElement('span');
    icon.className = 'status-icon';
    icon.textContent = getStatusIcon(file.status);
    
    const path = document.createElement('span');
    path.className = 'file-path';
    path.textContent = file.path;
    
    // Click file path to view diff (not for untracked - no diff available)
    if (section !== 'untracked') {
      path.classList.add('clickable');
      path.onclick = () => viewDiff(file.path, section === 'staged');
    }
    
    li.appendChild(icon);
    li.appendChild(path);
    
    // Add action button based on section
    if (section === 'staged') {
      const btn = document.createElement('button');
      btn.className = 'file-action unstage-btn';
      btn.title = 'Unstage';
      btn.textContent = '−';
      btn.onclick = (e) => { e.stopPropagation(); unstageFile(file.path); };
      li.appendChild(btn);
    } else if (section === 'unstaged' || section === 'untracked') {
      const btn = document.createElement('button');
      btn.className = 'file-action stage-btn';
      btn.title = 'Stage';
      btn.textContent = '+';
      btn.onclick = (e) => { e.stopPropagation(); stageFile(file.path); };
      li.appendChild(btn);
    }
    
    container.appendChild(li);
  }
}

// ============================================================
// Phase 2: Staging operations
// ============================================================

/**
 * Stage a single file
 */
async function stageFile(filePath) {
  const result = await runGit(['add', '--', filePath]);
  if (result.code !== 0) {
    showError(`Failed to stage ${filePath}: ${result.stderr}`);
    return;
  }
  await refresh();
}

/**
 * Unstage a single file
 */
async function unstageFile(filePath) {
  const result = await runGit(['restore', '--staged', '--', filePath]);
  if (result.code !== 0) {
    showError(`Failed to unstage ${filePath}: ${result.stderr}`);
    return;
  }
  await refresh();
}

/**
 * Stage all modified/deleted files
 */
async function stageAll() {
  const result = await runGit(['add', '-u']);
  if (result.code !== 0) {
    showError(`Failed to stage files: ${result.stderr}`);
    return;
  }
  await refresh();
}

/**
 * Stage all untracked files
 */
async function stageUntracked() {
  // Stage each untracked file individually
  for (const file of currentStatus.untracked) {
    const result = await runGit(['add', '--', file.path]);
    if (result.code !== 0) {
      showError(`Failed to stage ${file.path}: ${result.stderr}`);
      return;
    }
  }
  await refresh();
}

/**
 * Unstage all files
 */
async function unstageAll() {
  const result = await runGit(['restore', '--staged', '.']);
  if (result.code !== 0) {
    showError(`Failed to unstage files: ${result.stderr}`);
    return;
  }
  await refresh();
}

// ============================================================
// Phase 4: Commit operations
// ============================================================

/**
 * Commit staged changes
 */
async function commit() {
  const message = commitMessage.value.trim();
  if (!message) {
    showError('Please enter a commit message');
    return;
  }
  
  if (currentStatus.staged.length === 0) {
    showError('No staged changes to commit');
    return;
  }
  
  commitBtn.disabled = true;
  commitBtn.textContent = 'Committing...';
  
  const result = await runGit(['commit', '-m', message]);
  
  if (result.code !== 0) {
    showError(`Commit failed: ${result.stderr}`);
    commitBtn.disabled = false;
    commitBtn.textContent = 'Commit';
    return;
  }
  
  // Clear message and refresh
  commitMessage.value = '';
  commitBtn.textContent = 'Commit';
  await refresh();
}

/**
 * Update commit button state based on staged files
 */
function updateCommitButtonState() {
  const hasStagedFiles = currentStatus.staged.length > 0;
  const hasMessage = commitMessage.value.trim().length > 0;
  commitBtn.disabled = !hasStagedFiles || !hasMessage;
}

/**
 * Update visibility of section action buttons
 */
function updateSectionButtons() {
  // Show/hide "Stage all" for unstaged changes
  if (currentStatus.unstaged.length > 0) {
    stageAllBtn.classList.remove('hidden');
  } else {
    stageAllBtn.classList.add('hidden');
  }
  
  // Show/hide "Unstage all" for staged changes
  if (currentStatus.staged.length > 0) {
    unstageAllBtn.classList.remove('hidden');
  } else {
    unstageAllBtn.classList.add('hidden');
  }
  
  // Show/hide "Stage untracked" for untracked files
  if (currentStatus.untracked.length > 0) {
    stageUntrackedBtn.classList.remove('hidden');
  } else {
    stageUntrackedBtn.classList.add('hidden');
  }
}

// ============================================================
// Phase 5: Push/Pull operations
// ============================================================

// Track ahead/behind counts
let currentAhead = 0;
let currentBehind = 0;

/**
 * Get ahead/behind count for current branch
 * Uses: git rev-list --left-right --count @{u}...HEAD
 */
async function getAheadBehind() {
  const result = await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (result.code !== 0) {
    // No upstream or other error - hide the indicator
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
  
  // Output is "behind\tahead" (tab-separated)
  const parts = result.stdout.trim().split(/\s+/);
  const behind = parseInt(parts[0], 10) || 0;
  const ahead = parseInt(parts[1], 10) || 0;
  
  return { ahead, behind, hasUpstream: true };
}

/**
 * Update ahead/behind display
 */
function updateAheadBehindDisplay(ahead, behind, hasUpstream) {
  currentAhead = ahead;
  currentBehind = behind;
  
  if (!hasUpstream) {
    aheadBehind.classList.add('hidden');
    aheadBehind.textContent = '';
    pushBtn.disabled = true;
    pullBtn.disabled = true;
    pushBtn.title = 'No upstream branch';
    pullBtn.title = 'No upstream branch';
    return;
  }
  
  // Build display string
  const parts = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  
  if (parts.length > 0) {
    aheadBehind.textContent = parts.join(' ');
    aheadBehind.classList.remove('hidden');
  } else {
    aheadBehind.textContent = '';
    aheadBehind.classList.add('hidden');
  }
  
  // Enable/disable buttons based on state
  pushBtn.disabled = ahead === 0;
  pullBtn.disabled = behind === 0;
  pushBtn.title = ahead > 0 ? `Push ${ahead} commit${ahead > 1 ? 's' : ''}` : 'Nothing to push';
  pullBtn.title = behind > 0 ? `Pull ${behind} commit${behind > 1 ? 's' : ''}` : 'Nothing to pull';
}

/**
 * Push to remote
 */
async function push() {
  if (currentAhead === 0) {
    showError('Nothing to push');
    return;
  }
  
  pushBtn.disabled = true;
  pushBtn.textContent = '...';
  
  const result = await runGit(['push']);
  
  if (result.code !== 0) {
    showError(`Push failed: ${result.stderr}`);
    pushBtn.textContent = '↑';
    await refreshAheadBehind();
    return;
  }
  
  pushBtn.textContent = '↑';
  await refresh();
}

/**
 * Pull from remote
 */
async function pull() {
  if (currentBehind === 0) {
    showError('Nothing to pull');
    return;
  }
  
  pullBtn.disabled = true;
  pullBtn.textContent = '...';
  
  const result = await runGit(['pull']);
  
  if (result.code !== 0) {
    showError(`Pull failed: ${result.stderr}`);
    pullBtn.textContent = '↓';
    await refreshAheadBehind();
    return;
  }
  
  pullBtn.textContent = '↓';
  await refresh();
}

/**
 * Refresh just the ahead/behind count
 */
async function refreshAheadBehind() {
  const { ahead, behind, hasUpstream } = await getAheadBehind();
  updateAheadBehindDisplay(ahead, behind, hasUpstream);
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
 * Refresh git status
 */
async function refresh() {
  refreshBtn.classList.add('spinning');
  hideError();
  
  try {
    // Get branch
    const branch = await getBranch();
    branchName.textContent = branch;
    
    // Get ahead/behind count
    const { ahead, behind, hasUpstream } = await getAheadBehind();
    updateAheadBehindDisplay(ahead, behind, hasUpstream);
    
    // Get status
    const result = await runGit(['status', '--porcelain=v2']);
    
    if (result.code !== 0) {
      // Check if not a git repo
      if (result.stderr.includes('not a git repository')) {
        showError('Not a git repository');
        stagedFiles.innerHTML = '';
        unstagedFiles.innerHTML = '';
        untrackedFiles.innerHTML = '';
        stagedCount.textContent = '(0)';
        unstagedCount.textContent = '(0)';
        untrackedCount.textContent = '(0)';
        branchName.textContent = '—';
        currentStatus = { staged: [], unstaged: [], untracked: [] };
        updateSectionButtons();
        updateCommitButtonState();
        return;
      }
      showError(result.stderr || 'Git error');
      return;
    }
    
    // Parse and render
    const { staged, unstaged, untracked } = parseStatus(result.stdout);
    currentStatus = { staged, unstaged, untracked };
    
    renderFileList(stagedFiles, staged, 'staged');
    renderFileList(unstagedFiles, unstaged, 'unstaged');
    renderFileList(untrackedFiles, untracked, 'untracked');
    
    stagedCount.textContent = `(${staged.length})`;
    unstagedCount.textContent = `(${unstaged.length})`;
    untrackedCount.textContent = `(${untracked.length})`;
    
    // Update button visibility
    updateSectionButtons();
    updateCommitButtonState();
    
    // Show clean message if nothing changed
    const totalChanges = staged.length + unstaged.length + untracked.length;
    if (totalChanges === 0) {
      cleanMessage.classList.remove('hidden');
    } else {
      cleanMessage.classList.add('hidden');
    }
    
  } catch (error) {
    showError('Failed to get git status: ' + error.message);
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// Event listeners
refreshBtn.addEventListener('click', refresh);
stageAllBtn.addEventListener('click', stageAll);
unstageAllBtn.addEventListener('click', unstageAll);
stageUntrackedBtn.addEventListener('click', stageUntracked);
commitBtn.addEventListener('click', commit);
pushBtn.addEventListener('click', push);
pullBtn.addEventListener('click', pull);

// Update commit button state as user types
commitMessage.addEventListener('input', updateCommitButtonState);

// Allow Enter to commit (Shift+Enter for newline if we add multiline later)
commitMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !commitBtn.disabled) {
    e.preventDefault();
    commit();
  }
});

// Handle initial load + URL param changes
window.appletAPI.onUrlParamsChange((params) => {
  const newPath = params.path || '';
  if (newPath !== repoPath) {
    repoPath = newPath;
    if (!repoPath) {
      document.getElementById('noPathMessage').classList.remove('hidden');
      branchName.textContent = '—';
    } else {
      document.getElementById('noPathMessage').classList.add('hidden');
      if (repoPathLabel) repoPathLabel.textContent = repoPath;
      refresh();
    }
  }
});
