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

var currentPath = '';
var zoom = 1;
var panX = 0, panY = 0;
var isDragging = false;
var dragStartX = 0, dragStartY = 0;
var panStartX = 0, panStartY = 0;
var currentImg = null;

var ZOOM_LEVELS = [1, 2, 3, 4, 5, 6];

var container = document.getElementById('imageContainer');
var zoomLabel = document.getElementById('ivZoomLabel');

function applyTransform() {
  if (!currentImg) return;
  currentImg.style.transform = 'scale(' + zoom + ') translate(' + panX + 'px, ' + panY + 'px)';
  currentImg.style.cursor = zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default';
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function stepZoom(direction) {
  var idx = ZOOM_LEVELS.indexOf(zoom);
  if (idx === -1) {
    idx = ZOOM_LEVELS.findIndex(function(l) { return l >= zoom; });
    if (idx === -1) idx = ZOOM_LEVELS.length - 1;
    if (direction < 0) idx = Math.max(0, idx - 1);
  } else {
    idx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
  }
  zoom = ZOOM_LEVELS[idx];
  if (zoom <= 1) { panX = 0; panY = 0; }
  applyTransform();
}

function loadImage(path, force) {
  if (path === currentPath && !force) {
    // Re-clicked the same path. Reload anyway — the file on disk may have
    // changed since we last fetched it (common while iterating on graphics).
    force = true;
  }
  currentPath = path;
  resetView();
  currentImg = null;

  if (!path) {
    container.innerHTML = '<div class="empty-state">No image path specified</div>';
    document.getElementById('imagePath').textContent = '';
    window.appletAPI.setAppletState({ imagePath: null, loaded: false });
    return;
  }

  document.getElementById('imagePath').textContent = path.split(/[/\\]/).pop() || path;
  document.getElementById('imagePath').title = path;
  container.innerHTML = '<div class="loading">Loading...</div>';

  var img = document.createElement('img');
  img.src = '/api/file?path=' + encodeURIComponent(path) + '&t=' + Date.now();
  img.alt = path;
  img.draggable = false;

  img.onerror = function() {
    container.innerHTML = '<div class="error">Failed to load: ' + path.split(/[/\\]/).pop() + '</div>';
    currentImg = null;
    window.appletAPI.setAppletState({ imagePath: path, loaded: false, error: true });
  };

  img.onload = function() {
    container.innerHTML = '';
    container.appendChild(img);
    currentImg = img;
    applyTransform();
    var galleryLink = document.getElementById('ivGallery');
    if (galleryLink) {
      var parts = path.split(/[/\\]/);
      var dir = parts.slice(0, -1).join('/');
      if (dir) {
        galleryLink.href = '?applet=image-gallery&path=' + encodeURIComponent(dir);
        galleryLink.style.display = '';
      }
    }
    window.appletAPI.setAppletState({
      imagePath: path,
      loaded: true,
      width: img.naturalWidth,
      height: img.naturalHeight
    });
  };
}

container.addEventListener('mousedown', function(e) {
  if (!currentImg || zoom <= 1) return;
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  panStartX = panX;
  panStartY = panY;
  e.preventDefault();
  applyTransform();
});

window.addEventListener('mousemove', function(e) {
  if (!isDragging) return;
  panX = panStartX + (e.clientX - dragStartX) / zoom;
  panY = panStartY + (e.clientY - dragStartY) / zoom;
  applyTransform();
});

window.addEventListener('mouseup', function() {
  if (!isDragging) return;
  isDragging = false;
  applyTransform();
});

container.addEventListener('wheel', function(e) {
  if (!currentImg) return;
  e.preventDefault();
  stepZoom(e.deltaY > 0 ? -1 : 1);
}, { passive: false });

document.getElementById('ivZoomIn').addEventListener('click', function() { stepZoom(1); });
document.getElementById('ivZoomOut').addEventListener('click', function() { stepZoom(-1); });
document.getElementById('ivZoomReset').addEventListener('click', resetView);
document.getElementById('ivRefresh').addEventListener('click', function() {
  if (currentPath) loadImage(currentPath, true);
});

window.appletAPI.onUrlParamsChange(function(params) {
  loadImage(params.path || '', false);
});
})();
