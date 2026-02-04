var currentPath = '';

function loadImage(path) {
  if (path === currentPath) return; // Already showing this image
  currentPath = path;
  
  var container = document.getElementById('imageContainer');
  
  if (!path) {
    container.innerHTML = '<div class="empty-state">No image path specified</div>';
    document.getElementById('imagePath').textContent = '';
    window.appletAPI.setAppletState({ imagePath: null, loaded: false });
    return;
  }
  
  document.getElementById('imagePath').textContent = path;
  container.innerHTML = '<div class="loading">Loading...</div>';
  
  var img = document.createElement('img');
  img.src = '/api/file?path=' + encodeURIComponent(path);
  img.alt = path;
  
  img.onerror = function() {
    container.innerHTML = '<div class="error">Failed to load image: ' + path + '</div>';
    window.appletAPI.setAppletState({ imagePath: path, loaded: false, error: true });
  };
  
  img.onload = function() {
    container.innerHTML = '';
    container.appendChild(img);
    window.appletAPI.setAppletState({
      imagePath: path,
      loaded: true,
      width: img.naturalWidth,
      height: img.naturalHeight
    });
  };
}

// Handle initial load + URL param changes (back/forward, chat links)
window.appletAPI.onUrlParamsChange(function(params) {
  loadImage(params.path || '');
});
