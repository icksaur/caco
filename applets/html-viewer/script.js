var currentPath = '';
var frame = document.getElementById('hvFrame');
var pathEl = document.getElementById('filePath');
var folderLink = document.getElementById('folderLink');
var refreshBtn = document.getElementById('refreshBtn');

function loadFile(path, force) {
  if (!path) {
    pathEl.textContent = 'No file loaded';
    pathEl.removeAttribute('href');
    folderLink.style.display = 'none';
    frame.removeAttribute('src');
    frame.srcdoc = '<div style="font-family:sans-serif;color:#888;padding:20px;text-align:center">Use: ?applet=html-viewer&amp;path=file.html</div>';
    window.appletAPI.setAppletState({ path: null, loaded: false });
    return;
  }
  currentPath = path;
  pathEl.textContent = path.split(/[/\\]/).pop() || path;
  pathEl.title = path;
  pathEl.href = '?applet=text-editor&path=' + encodeURIComponent(path);

  var parts = path.split(/[/\\]/);
  var dir = parts.slice(0, -1).join('/');
  if (dir) {
    folderLink.href = '?applet=file-finder&root=' + encodeURIComponent(dir);
    folderLink.style.display = '';
  } else {
    folderLink.style.display = 'none';
  }

  frame.removeAttribute('srcdoc');
  var bust = force ? '&t=' + Date.now() : '';
  frame.src = '/api/file?path=' + encodeURIComponent(path) + bust;
  window.appletAPI.setAppletState({ path: path, loaded: true });
}

refreshBtn.addEventListener('click', function() {
  if (currentPath) loadFile(currentPath, true);
});

window.appletAPI.onUrlParamsChange(function(params) {
  var newPath = params.path || '';
  if (newPath !== currentPath) loadFile(newPath, false);
});
