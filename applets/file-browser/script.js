var currentPath = '';

async function loadDirectory(path, navigate) {
  currentPath = path || '';
  
  var fileList = document.getElementById('fileList');
  fileList.innerHTML = '<div class="loading">Loading...</div>';
  
  try {
    var response = await fetch('/api/files?path=' + encodeURIComponent(currentPath));
    var data = await response.json();
    
    if (!response.ok) {
      fileList.innerHTML = '<div class="empty-state">Error: ' + data.error + '</div>';
      return;
    }
    
    // API returns absolute path in data.path
    currentPath = data.path;
    
    // Update URL after API resolves to canonical absolute path
    if (navigate) {
      window.appletAPI.navigateAppletUrlParam('path', currentPath);
    }
    
    renderBreadcrumb(data.path);
    renderContextLinks(data.path);
    renderFiles(data.files);
    
    setAppletState({
      currentPath: currentPath,
      fileCount: data.files.length
    });
  } catch (err) {
    fileList.innerHTML = '<div class="empty-state">Error: ' + err.message + '</div>';
  }
}

// Normalize path separators: convert backslashes to forward slashes for consistent handling.
// The API accepts both, so we can work with forward slashes everywhere in the client.
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function renderBreadcrumb(absPath) {
  var bc = document.getElementById('breadcrumb');
  absPath = normalizePath(absPath);
  var parts = absPath.split('/').filter(Boolean);
  
  // Detect Windows drive letter (e.g. "C:")
  var isWindows = parts.length > 0 && /^[A-Za-z]:$/.test(parts[0]);
  var rootPath = isWindows ? parts[0] + '/' : '/';
  var rootLabel = isWindows ? parts[0] + '/' : '/ root';
  var startIndex = isWindows ? 1 : 0;
  
  var html = '<span class="breadcrumb-item" data-path="' + rootPath + '">' + rootLabel + '</span>';
  var accumulated = isWindows ? parts[0] : '';
  
  for (var i = startIndex; i < parts.length; i++) {
    accumulated += '/' + parts[i];
    html += '<span class="breadcrumb-sep">/</span>';
    html += '<span class="breadcrumb-item" data-path="' + accumulated + '">' + parts[i] + '</span>';
  }
  
  bc.innerHTML = html;
  
  bc.querySelectorAll('.breadcrumb-item').forEach(function(item) {
    item.addEventListener('click', function() {
      loadDirectory(this.getAttribute('data-path'), true);
    });
  });
}

async function renderContextLinks(absPath) {
  var el = document.getElementById('contextLinks');
  el.innerHTML = '';
  absPath = normalizePath(absPath);
  
  try {
    var resp = await fetch('/api/files?path=' + encodeURIComponent(absPath + '/.git'));
    if (resp.ok) {
      var link = document.createElement('a');
      link.className = 'context-link';
      link.href = '?applet=git-status&path=' + encodeURIComponent(absPath);
      link.textContent = 'git-status';
      el.appendChild(link);
    }
  } catch (_) {}
}

function joinPath(base, name) {
  base = normalizePath(base);
  if (base === '/' || base.match(/^[A-Za-z]:\/$/)) return base + name;
  return base + '/' + name;
}

function renderFiles(files) {
  var fileList = document.getElementById('fileList');
  
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">Empty directory</div>';
    return;
  }
  
  var html = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var icon = f.type === 'directory' ? '📁' : getFileIcon(f.name);
    var size = f.type === 'file' ? formatSize(f.size) : '';
    var filePath = joinPath(currentPath, f.name);
    
    if (f.type === 'directory') {
      // Directories reload current applet - use div with click handler
      html += '<div class="file-item" data-name="' + f.name + '" data-type="directory">';
      html += '<span class="file-icon">' + icon + '</span>';
      html += '<span class="file-name">' + f.name + '</span>';
      html += '<span class="file-size">' + size + '</span>';
      html += '</div>';
    } else {
      // Files link to appropriate applet
      var ext = f.name.split('.').pop().toLowerCase();
      var imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      var markdownExts = ['md', 'mdx', 'markdown'];
      var binaryExts = ['zip', 'tar', 'gz', 'exe', 'bin', 'dll', 'so', 'pdf'];
      var href;
      
      if (imageExts.indexOf(ext) !== -1) {
        href = '?applet=image-viewer&path=' + encodeURIComponent(filePath);
      } else if (markdownExts.indexOf(ext) !== -1) {
        href = '?applet=markdown-viewer&path=' + encodeURIComponent(filePath);
      } else if (binaryExts.indexOf(ext) !== -1) {
        href = null; // Binary files don't navigate
      } else {
        href = '?applet=text-editor&path=' + encodeURIComponent(filePath);
      }
      
      if (href) {
        html += '<a class="file-item" href="' + href + '">';
      } else {
        html += '<div class="file-item file-binary" data-path="' + filePath + '">';
      }
      html += '<span class="file-icon">' + icon + '</span>';
      html += '<span class="file-name">' + f.name + '</span>';
      html += '<span class="file-size">' + size + '</span>';
      html += (href ? '</a>' : '</div>');
    }
  }
  
  fileList.innerHTML = html;
  
  // Directory click handlers (reload current view)
  fileList.querySelectorAll('.file-item[data-type="directory"]').forEach(function(item) {
    item.addEventListener('click', function() {
      var name = this.getAttribute('data-name');
      var newPath = joinPath(currentPath, name);
      loadDirectory(newPath, true);
    });
  });
  
  // Binary file click handlers
  fileList.querySelectorAll('.file-binary').forEach(function(item) {
    item.addEventListener('click', function() {
      var filePath = this.getAttribute('data-path');
      setAppletState({ selectedFile: filePath, action: 'binary_file' });
    });
  });
}

function getFileIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  var icons = {
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
    json: '📋', md: '📝', txt: '📝',
    html: '🌐', css: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    sh: '⚙️', bash: '⚙️'
  };
  return icons[ext] || '📄';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Handle initial load + URL param changes (back/forward, chat links)
window.appletAPI.onUrlParamsChange(function(params) {
  loadDirectory(params.path || '', false);
});