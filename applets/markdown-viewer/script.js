var currentFilePath = '';

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

    status.textContent = text.length + ' chars';
    window.appletAPI.setAppletState({ path: path, loaded: true, size: text.length });
  } catch (err) {
    content.innerHTML = '<div class="error">Error: ' + err.message + '</div>';
    status.textContent = 'Failed to load';
    status.className = 'status error';
  }
}

window.appletAPI.onUrlParamsChange(function(params) {
  var newPath = params.path || '';
  if (newPath !== currentFilePath) {
    currentFilePath = newPath;
    loadFile(currentFilePath);
  }
});
