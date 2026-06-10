(function() {
  // V5: deprecated applet. When a session exists, redirect to
  // the unified "files" applet. Otherwise fall through to the
  // standalone behavior so direct deep-link URLs without a
  // session still render. See docs/files-applet-v5.md §4.2.
  var api = window.appletAPI;
  if (api && typeof api.getSessionId === 'function' && api.getSessionId()) {
    var p = new URLSearchParams(window.location.search);
    var target = new URLSearchParams(p);
    target.set('applet', 'files');
    var srcPath = p.get("path") || "";
    target.delete("path");
    if (srcPath) target.set("openPath", srcPath);
    var url = '?' + target.toString();
    if (window.navigation && typeof window.navigation.navigate === 'function') {
      try { window.navigation.navigate(url); return; } catch (_e) {}
    }
    window.location.href = '/' + url;
    return;
  }

var currentFilePath = '';
var currentWatcher = null;

var content = document.getElementById('content');
var status = document.getElementById('status');
var filePathEl = document.getElementById('filePath');

async function loadFile(path) {
  if (!path) {
    filePathEl.textContent = 'No file loaded';
    filePathEl.removeAttribute('href');
    content.innerHTML = '<div class="empty-state">Use: ?applet=markdown-viewer&path=file.md</div>';
    content.classList.remove('markdown-content');
    status.textContent = '';
    return;
  }

  filePathEl.textContent = path;
  filePathEl.href = '?applet=text-editor&path=' + encodeURIComponent(path);
  status.textContent = 'Loading...';
  status.className = 'status';

  try {
    var response = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var text = await response.text();

    content.textContent = text;
    window.renderMarkdownElement(content);

    if (typeof hljs !== 'undefined') {
      content.querySelectorAll('pre code').forEach(function(block) {
        hljs.highlightElement(block);
      });
    }

    status.textContent = text.length + ' chars · live';
    window.appletAPI.setAppletState({ path: path, loaded: true, size: text.length });
  } catch (err) {
    content.innerHTML = '<div class="error">Error: ' + err.message + '</div>';
    status.textContent = 'Failed to load';
    status.className = 'status error';
  }
}

async function setupWatcher(path) {
  if (currentWatcher) {
    try { await currentWatcher.close(); } catch (_e) { /* ignore */ }
    currentWatcher = null;
  }
  if (!path) return;
  try {
    var w = await window.appletAPI.watchPath(path, { scope: 'file' });
    w.onChange(function () { loadFile(path); });
    currentWatcher = w;
  } catch (err) {
    // Watch failure is non-fatal; the user still gets the initial render.
    console.warn('[markdown-viewer] watchPath failed:', err.message || err);
  }
}

window.appletAPI.onUrlParamsChange(function(params) {
  var newPath = params.path || '';
  if (newPath !== currentFilePath) {
    currentFilePath = newPath;
    loadFile(currentFilePath);
    setupWatcher(currentFilePath);
  }
});
})();
