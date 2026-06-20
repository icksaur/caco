var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

var grid = document.getElementById('igGrid');
var pathEl = document.getElementById('igPath');
var emptyEl = document.getElementById('igEmpty');
var errorEl = document.getElementById('igError');
var observer = null;
var galleryEpoch = 0;

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function isImage(name) {
  var ext = (name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.indexOf(ext) !== -1;
}

function loadGallery(dirPath) {
  var myLoad = ++galleryEpoch;
  if (!dirPath) {
    grid.innerHTML = '';
    emptyEl.style.display = '';
    errorEl.style.display = 'none';
    pathEl.textContent = '';
    return;
  }

  pathEl.textContent = dirPath;
  pathEl.title = dirPath;
  grid.innerHTML = '';
  emptyEl.style.display = 'none';
  errorEl.style.display = 'none';

  fetch('/api/files?path=' + encodeURIComponent(dirPath))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (myLoad !== galleryEpoch) return;
      var images = (data.files || []).filter(function(f) {
        return f.type === 'file' && isImage(f.name);
      });

      if (images.length === 0) {
        emptyEl.style.display = '';
        return;
      }

      if (observer) observer.disconnect();
      observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (!entry.isIntersecting) return;
          var cell = entry.target;
          var imgPath = cell.dataset.path;
          if (!imgPath || cell.dataset.loaded) return;
          cell.dataset.loaded = '1';
          var img = document.createElement('img');
          img.alt = cell.dataset.name || '';
          img.draggable = false;
          img.src = '/api/file?path=' + encodeURIComponent(imgPath);
          img.onerror = function() {
            cell.classList.add('ig-cell-error');
            cell.querySelector('.ig-thumb')?.remove();
            var msg = document.createElement('div');
            msg.className = 'ig-cell-msg';
            msg.textContent = 'failed';
            cell.insertBefore(msg, cell.firstChild);
          };
          var thumb = cell.querySelector('.ig-thumb');
          if (thumb) thumb.appendChild(img);
          observer.unobserve(cell);
        });
      }, { rootMargin: '200px' });

      var html = '';
      for (var i = 0; i < images.length; i++) {
        var f = images[i];
        var absPath = data.path + '/' + f.name;
        var viewerUrl = '?applet=files&openPath=' + encodeURIComponent(absPath);
        html += '<a class="ig-cell" data-path="' + esc(absPath) + '" data-name="' + esc(f.name) + '" href="' + esc(viewerUrl) + '">';
        html += '<div class="ig-thumb"></div>';
        html += '<div class="ig-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>';
        html += '</a>';
      }
      grid.innerHTML = html;

      grid.querySelectorAll('.ig-cell').forEach(function(cell) {
        observer.observe(cell);
      });
    })
    .catch(function(err) {
      if (myLoad !== galleryEpoch) return;
      errorEl.textContent = 'Failed to load: ' + (err.message || err);
      errorEl.style.display = '';
    });
}

window.appletAPI.onUrlParamsChange(function(params) {
  loadGallery(params.path || '');
});
