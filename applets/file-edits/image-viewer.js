/**
 * ImageViewer — ViewerInstance for raster + SVG images.
 *
 * V2.a port of applets/image-viewer/script.js into the V1.1
 * ViewerInstance contract (docs/files-applet-v2.md §4.1).
 *
 * Zoom levels [1..6] via wheel/buttons; mouse-drag pan when
 * zoomed > 1. Cache-busting `&t=Date.now()` query string forces
 * the browser to re-fetch on watcher events.
 *
 * Window-scoped mousemove/mouseup listeners are wired in the
 * constructor and torn down in destroy() so dragging from one
 * tab's image doesn't bleed into another.
 */

(function() {
  var ZOOM_LEVELS = [1, 2, 3, 4, 5, 6];

  function ImageViewer(shell, container, absPath) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'image';
    this.destroyed = false;
    this._watcher = null;
    this._abort = null;
    this.loaded = false;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._panStartX = 0;
    this._panStartY = 0;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-image-content';
    this.contentEl.style.display = 'none';

    // Zoom HUD (bottom-left, doesn't interfere with viewer toggle top-right).
    this._zoomHud = document.createElement('div');
    this._zoomHud.className = 'files-image-zoom';
    this._zoomHud.textContent = '100%';
    this.contentEl.appendChild(this._zoomHud);

    this._imgWrap = document.createElement('div');
    this._imgWrap.className = 'files-image-wrap';
    this.contentEl.appendChild(this._imgWrap);

    this._img = null;
    this._installPointerHandlers();
  }

  ImageViewer.prototype._applyTransform = function() {
    if (!this._img) return;
    this._img.style.transform =
      'scale(' + this.zoom + ') translate(' + this.panX + 'px, ' + this.panY + 'px)';
    this._img.style.cursor = this.zoom > 1 ? (this._isDragging ? 'grabbing' : 'grab') : 'default';
    this._zoomHud.textContent = Math.round(this.zoom * 100) + '%';
  };

  ImageViewer.prototype._resetView = function() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._applyTransform();
  };

  ImageViewer.prototype._stepZoom = function(direction) {
    var idx = ZOOM_LEVELS.indexOf(this.zoom);
    if (idx === -1) {
      idx = ZOOM_LEVELS.findIndex(function(l) { return l >= this.zoom; }.bind(this));
      if (idx === -1) idx = ZOOM_LEVELS.length - 1;
      if (direction < 0) idx = Math.max(0, idx - 1);
    } else {
      idx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
    }
    this.zoom = ZOOM_LEVELS[idx];
    if (this.zoom <= 1) { this.panX = 0; this.panY = 0; }
    this._applyTransform();
  };

  ImageViewer.prototype._installPointerHandlers = function() {
    var self = this;
    this._onMouseDown = function(e) {
      if (self.destroyed || !self._img || self.zoom <= 1) return;
      self._isDragging = true;
      self._dragStartX = e.clientX;
      self._dragStartY = e.clientY;
      self._panStartX = self.panX;
      self._panStartY = self.panY;
      e.preventDefault();
      self._applyTransform();
    };
    this._onMouseMove = function(e) {
      if (!self._isDragging || self.destroyed) return;
      self.panX = self._panStartX + (e.clientX - self._dragStartX) / self.zoom;
      self.panY = self._panStartY + (e.clientY - self._dragStartY) / self.zoom;
      self._applyTransform();
    };
    this._onMouseUp = function() {
      if (!self._isDragging) return;
      self._isDragging = false;
      self._applyTransform();
    };
    this._onWheel = function(e) {
      if (self.destroyed || !self._img) return;
      e.preventDefault();
      self._stepZoom(e.deltaY > 0 ? -1 : 1);
    };
    this._imgWrap.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    this._imgWrap.addEventListener('wheel', this._onWheel, { passive: false });
  };

  ImageViewer.prototype.load = function() {
    if (this.destroyed) return;
    this._resetView();
    this._imgWrap.innerHTML = '';
    var img = document.createElement('img');
    img.alt = this.absPath;
    img.draggable = false;
    var self = this;
    img.onerror = function() {
      if (self.destroyed) return;
      self.loaded = false;
      self._imgWrap.innerHTML = '<div class="files-image-error">Failed to load</div>';
      self.shell.echoState();
    };
    img.onload = function() {
      if (self.destroyed) return;
      self.loaded = true;
      self._img = img;
      self._applyTransform();
      self.shell.echoState();
    };
    img.src = '/api/file?path=' + encodeURIComponent(this.absPath) + '&t=' + Date.now();
    this._img = null;
    this._imgWrap.appendChild(img);
  };

  ImageViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
  };
  ImageViewer.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
  };

  ImageViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._img) {
      this._img.onload = null;
      this._img.onerror = null;
      this._img.src = '';
      this._img = null;
    }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function() {}); }
      catch (_e) { /* ignore */ }
    }
    this._imgWrap.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    this._imgWrap.removeEventListener('wheel', this._onWheel);
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  ImageViewer.prototype.echoState = function() {
    return {
      kind: 'image',
      path: this.absPath,
      loaded: this.loaded,
      zoom: this.zoom,
    };
  };

  ImageViewer.open = async function(shell, container, absPath, _relPath) {
    var inst = new ImageViewer(shell, container, absPath);
    try {
      inst._watcher = await shell.api.watchPath(absPath, { scope: 'file' });
      if (inst.destroyed) {
        try { inst._watcher.close(); } catch (_e) { /* ignore */ }
        throw new Error('aborted');
      }
      inst._watcher.onChange(function() { inst.load(); });
      inst.load();
    } catch (err) {
      inst.destroy();
      throw err;
    }
    // Container may have been destroyed during the await above
    // (user closed the tab, session switched). Bail before
    // appending into a nulled-out parent.
    if (container.destroyed || !container.contentEl) {
      inst.destroy();
      throw new Error('container destroyed during open');
    }
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.ImageViewer = ImageViewer;
})();
