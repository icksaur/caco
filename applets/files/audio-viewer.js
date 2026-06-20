/**
 * AudioViewer — ViewerInstance for browser-native audio playback.
 *
 * Mirrors ImageViewer (binary content, watcher-driven reload, no text).
 * Renders a single reused <audio controls> element; on a watcher event
 * the src is cache-busted and re-fetched via the native audio.load() so a
 * freshly re-rendered file (e.g. a synth .wav) reloads in place.
 *
 * Media listeners (loadedmetadata/error) are bound ONCE in the constructor
 * and removed in destroy() — never per load() — so watcher reloads don't
 * leak or double-fire. Playback resets to the start on reload (regenerated
 * content) and pauses on deactivate so a hidden tab is never still playing.
 */

(function() {
  function AudioViewer(shell, container, absPath) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'audio';
    this.destroyed = false;
    this._watcher = null;
    this.loaded = false;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-audio-content';
    this.contentEl.style.display = 'none';

    var caption = document.createElement('div');
    caption.className = 'files-audio-caption';
    caption.textContent = AudioViewer._basename(absPath);
    this.contentEl.appendChild(caption);
    this._caption = caption;

    var audio = document.createElement('audio');
    audio.className = 'files-audio-el';
    audio.controls = true;
    audio.preload = 'metadata';
    this.contentEl.appendChild(audio);
    this.audio = audio;

    var self = this;
    this._onLoadedMeta = function() {
      if (self.destroyed) return;
      self.loaded = true;
      self._clearError();
      self.shell.echoState();
    };
    this._onError = function() {
      if (self.destroyed) return;
      self.loaded = false;
      self._showError();
      self.shell.echoState();
    };
    audio.addEventListener('loadedmetadata', this._onLoadedMeta);
    audio.addEventListener('error', this._onError);
  }

  AudioViewer.prototype._showError = function() {
    if (this._errorEl) return;
    var err = document.createElement('div');
    err.className = 'files-audio-error';
    err.textContent = 'Failed to load';
    this.contentEl.appendChild(err);
    this._errorEl = err;
  };

  AudioViewer.prototype._clearError = function() {
    if (this._errorEl && this._errorEl.parentNode) {
      this._errorEl.parentNode.removeChild(this._errorEl);
    }
    this._errorEl = null;
  };

  AudioViewer.prototype.load = function() {
    if (this.destroyed) return;
    this.loaded = false;
    this._clearError();
    // Reused <audio> requires native load() to re-fetch after a src change.
    this.audio.src = '/api/file?path=' + encodeURIComponent(this.absPath) + '&t=' + Date.now();
    this.audio.load();
  };

  AudioViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
  };

  AudioViewer.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
    if (this.audio && !this.audio.paused) {
      try { this.audio.pause(); } catch (_e) { /* ignore */ }
    }
  };

  AudioViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.audio) {
      try { this.audio.pause(); } catch (_e) { /* ignore */ }
      this.audio.removeEventListener('loadedmetadata', this._onLoadedMeta);
      this.audio.removeEventListener('error', this._onError);
      // Abort any in-flight fetch: drop src then load() the now-empty element.
      this.audio.removeAttribute('src');
      try { this.audio.load(); } catch (_e) { /* ignore */ }
      this.audio = null;
    }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function() {}); }
      catch (_e) { /* ignore */ }
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  AudioViewer.prototype.echoState = function() {
    return {
      kind: 'audio',
      path: this.absPath,
      loaded: this.loaded,
    };
  };

  /** Final path segment (POSIX or Windows). */
  AudioViewer._basename = function(p) {
    if (!p) return '';
    var norm = p.replace(/[\\/]+$/, '');
    var idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx < 0 ? norm : norm.slice(idx + 1);
  };

  AudioViewer.open = async function(shell, container, absPath, _relPath, opts) {
    var inst = new AudioViewer(shell, container, absPath);
    try {
      if (!opts || opts.watch !== false) {
        inst._watcher = await shell.api.watchPath(absPath, { scope: 'file' });
        if (inst.destroyed) {
          try { inst._watcher.close(); } catch (_e) { /* ignore */ }
          throw new Error('aborted');
        }
        inst._watcher.onChange(function() { inst.load(); });
      }
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
  window.__filesApplet.AudioViewer = AudioViewer;
})();
