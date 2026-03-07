var rootPath = '';
var allFiles = [];
var dirEntries = [];
var filtered = [];
var selectedIdx = 0;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var searchInput = document.getElementById('searchInput');
var results = document.getElementById('results');
var status = document.getElementById('status');
var refreshBtn = document.getElementById('refreshBtn');
var breadcrumb = document.getElementById('breadcrumb');

var fileIcons = {
  js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
  json: '📋', md: '📝', txt: '📝',
  html: '🌐', css: '🎨',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
  sh: '⚙️', bash: '⚙️'
};

function getIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  return fileIcons[ext] || '📄';
}

function getApplet(name) {
  var ext = name.split('.').pop().toLowerCase();
  var imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  var mdExts = ['md', 'mdx', 'markdown'];
  if (imageExts.indexOf(ext) !== -1) return 'image-viewer';
  if (mdExts.indexOf(ext) !== -1) return 'markdown-viewer';
  return 'text-editor';
}

function fuzzyScore(query, target) {
  var q = query.toLowerCase();
  var t = target.toLowerCase();
  if (t.indexOf(q) !== -1) return 100 + (q.length / t.length) * 50;
  var qi = 0;
  var score = 0;
  var lastMatch = -1;
  for (var ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10;
      if (lastMatch === ti - 1) score += 5;
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '-' || t[ti - 1] === '_') score += 10;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

function absolutePath(relPath) {
  if (rootPath.endsWith('/')) return rootPath + relPath;
  return rootPath + '/' + relPath;
}

function navigateRoot(newRoot) {
  rootPath = newRoot;
  window.appletAPI.navigateAppletUrlParam('root', rootPath);
  loadFiles();
}

function renderBreadcrumb() {
  var parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean);
  var isWindows = parts.length > 0 && /^[A-Za-z]:$/.test(parts[0]);
  var rootLabel = isWindows ? parts[0] + '/' : '/';
  var startIdx = isWindows ? 1 : 0;

  var html = '<span class="bc-item" data-path="' + (isWindows ? parts[0] + '/' : '/') + '">' + rootLabel + '</span>';
  var acc = isWindows ? parts[0] : '';
  for (var i = startIdx; i < parts.length; i++) {
    acc += '/' + parts[i];
    html += '<span class="bc-sep">/</span>';
    html += '<span class="bc-item" data-path="' + esc(acc) + '">' + esc(parts[i]) + '</span>';
  }
  breadcrumb.innerHTML = html;

  breadcrumb.querySelectorAll('.bc-item').forEach(function(item) {
    item.addEventListener('click', function() {
      navigateRoot(this.getAttribute('data-path'));
    });
  });
}

async function loadFiles() {
  results.innerHTML = '<div class="empty-state">Loading...</div>';
  status.textContent = '';
  renderBreadcrumb();

  try {
    var enc = encodeURIComponent(rootPath);
    var responses = await Promise.all([
      fetch('/api/project-files?cwd=' + enc + '&noignore=1'),
      fetch('/api/files?path=' + enc + '&dotfiles=1')
    ]);
    if (!responses[0].ok) throw new Error('HTTP ' + responses[0].status);
    var projectData = await responses[0].json();
    allFiles = projectData.files;

    if (responses[1].ok) {
      var dirData = await responses[1].json();
      dirEntries = dirData.files;
    } else {
      dirEntries = [];
    }

    status.textContent = allFiles.length + ' files';
    searchInput.value = '';
    filtered = allFiles;
    selectedIdx = 0;
    render();
    window.appletAPI.setAppletState({ root: rootPath, fileCount: allFiles.length, loaded: true });
  } catch (err) {
    results.innerHTML = '<div class="empty-state error">Failed to load: ' + esc(rootPath) + '<br>' + esc(err.message) + '</div>';
  }
}

function filter(query) {
  if (!query) {
    filtered = allFiles;
  } else {
    filtered = allFiles
      .map(function(f) { return { path: f, score: fuzzyScore(query, f) }; })
      .filter(function(s) { return s.score > 0; })
      .sort(function(a, b) { return b.score - a.score; })
      .map(function(s) { return s.path; });
  }
  selectedIdx = 0;
  render();
}

function renderDirRow(dirName) {
  var absDirPath = absolutePath(dirName);
  return '<div class="result-item result-dir" data-dir="' + esc(absDirPath) + '">' +
    '<span class="result-icon">📁</span>' +
    '<span class="result-path">' + esc(dirName) + '/</span>' +
    '<span class="copy-btn" data-copy="' + esc(absDirPath) + '" title="Copy path">📋</span>' +
    '</div>';
}

function render() {
  var max = 200;
  var query = searchInput.value;
  var html = '';

  if (!query) {
    var dirs = dirEntries.filter(function(e) { return e.type === 'directory'; });
    var files = dirEntries.filter(function(e) { return e.type === 'file'; });

    if (dirs.length === 0 && files.length === 0) {
      results.innerHTML = '<div class="empty-state">Empty directory</div>';
      status.textContent = allFiles.length + ' files';
      return;
    }

    for (var d = 0; d < dirs.length; d++) {
      html += renderDirRow(dirs[d].name);
    }
    for (var fi = 0; fi < files.length; fi++) {
      var f = files[fi].name;
      var absPath = absolutePath(f);
      var applet = getApplet(f);
      html += '<a class="result-item" href="?applet=' + applet + '&path=' + encodeURIComponent(absPath) + '" data-path="' + esc(absPath) + '">';
      html += '<span class="result-icon">' + getIcon(f) + '</span>';
      html += '<span class="result-path">' + esc(f) + '</span>';
      html += '<span class="copy-btn" data-copy="' + esc(absPath) + '" title="Copy path">📋</span>';
      html += '</a>';
    }

    results.innerHTML = html;
    status.textContent = dirs.length + ' folders · ' + allFiles.length + ' files';
  } else {
    var shown = filtered.slice(0, max);

    if (shown.length === 0) {
      results.innerHTML = '<div class="empty-state">No matches</div>';
      status.textContent = allFiles.length + ' files';
      return;
    }

    var seenDirs = {};
    for (var i = 0; i < shown.length; i++) {
      var f = shown[i];
      var absPath = absolutePath(f);
      var name = f.split('/').pop();
      var applet = getApplet(name);
      var cls = 'result-item' + (i === selectedIdx ? ' selected' : '');

      var dirPath = f.indexOf('/') !== -1 ? f.substring(0, f.indexOf('/')) : null;
      if (dirPath && !seenDirs[dirPath]) {
        seenDirs[dirPath] = true;
        html += renderDirRow(dirPath);
      }

      html += '<a class="' + cls + '" href="?applet=' + applet + '&path=' + encodeURIComponent(absPath) + '" data-idx="' + i + '" data-path="' + esc(absPath) + '">';
      html += '<span class="result-icon">' + getIcon(name) + '</span>';
      html += '<span class="result-path">' + esc(f) + '</span>';
      html += '<span class="copy-btn" data-copy="' + esc(absPath) + '" title="Copy path">📋</span>';
      html += '</a>';
    }

    results.innerHTML = html;
    var extra = filtered.length > max ? ' (' + filtered.length + ' total)' : '';
    status.textContent = shown.length + ' results' + extra + ' · ' + allFiles.length + ' files';
  }

  results.querySelectorAll('.copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var path = this.getAttribute('data-copy');
      var row = this.closest('.result-item');
      navigator.clipboard.writeText(path).then(function() {
        btn.textContent = '✓';
        row.classList.add('copied');
        status.textContent = 'Copied!';
        setTimeout(function() {
          btn.textContent = '📋';
          row.classList.remove('copied');
          filter(searchInput.value);
        }, 800);
      });
    });
  });

  results.querySelectorAll('.result-dir').forEach(function(row) {
    row.addEventListener('click', function(e) {
      if (e.target.closest('.copy-btn')) return;
      navigateRoot(this.getAttribute('data-dir'));
    });
  });
}

function scrollToSelected() {
  var sel = results.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('input', function() {
  filter(this.value);
});

searchInput.addEventListener('keydown', function(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx = Math.min(selectedIdx + 1, Math.min(filtered.length, 200) - 1);
    render();
    scrollToSelected();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx = Math.max(selectedIdx - 1, 0);
    render();
    scrollToSelected();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    var sel = results.querySelector('.result-item.selected');
    if (sel && sel.href) window.location.href = sel.href;
  }
});

refreshBtn.addEventListener('click', function() {
  allFiles = [];
  loadFiles();
});

window.appletAPI.onUrlParamsChange(function(params) {
  var newRoot = params.root || '';
  if (!newRoot) {
    results.innerHTML = '<div class="empty-state">Use: ?applet=file-finder&root=/path/to/folder</div>';
    return;
  }
  if (newRoot !== rootPath) {
    rootPath = newRoot;
    loadFiles();
  }
});
