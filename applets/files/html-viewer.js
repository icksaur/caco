/**
 * HtmlViewer — ViewerInstance for HTML files (sandboxed iframe).
 *
 * V2.b port of applets/html-viewer/script.js into the V1.1
 * ViewerInstance contract (docs/files-applet-v2.md §4.2).
 *
 * The iframe loads `/api/file?path=` directly; the server sets
 * CSP for HTML responses (src/routes/api.ts:414-417). The
 * iframe sandbox attribute is `allow-scripts allow-popups
 * allow-popups-to-escape-sandbox` — same as the standalone
 * html-viewer applet. No access to Caco session, storage, or DOM.
 *
 * Watcher fires on disk change → load() re-sets iframe.src with
 * a cache-bust query string, forcing a full reload.
 */

(function() {
  function HtmlViewer(shell, container, absPath) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'html';
    this.destroyed = false;
    this._watcher = null;
    this.loaded = false;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-html-content';
    this.contentEl.style.display = 'none';

    this._iframe = document.createElement('iframe');
    this._iframe.className = 'files-html-frame';
    this._iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    var self = this;
    this._iframe.addEventListener('load', function() {
      if (self.destroyed) return;
      self.loaded = true;
      self.shell.echoState();
    });
    this.contentEl.appendChild(this._iframe);
  }

  HtmlViewer.prototype.viewerType = 'html';

  HtmlViewer.prototype.load = function() {
    if (this.destroyed) return;
    this._iframe.src =
      '/api/file?path=' + encodeURIComponent(this.absPath) + '&t=' + Date.now();
  };

  HtmlViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
  };
  HtmlViewer.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
  };

  HtmlViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._iframe) {
      // Clear src first so the iframe stops loading; otherwise an
      // in-flight request keeps churning after detach.
      try { this._iframe.src = 'about:blank'; } catch (_e) { /* ignore */ }
    }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function() {}); }
      catch (_e) { /* ignore */ }
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  HtmlViewer.prototype.echoState = function() {
    return { kind: 'html', path: this.absPath, loaded: this.loaded };
  };

  HtmlViewer.open = async function(shell, container, absPath, _relPath) {
    var inst = new HtmlViewer(shell, container, absPath);
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
    if (container.destroyed || !container.contentEl) {
      inst.destroy();
      throw new Error('container destroyed during open');
    }
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.HtmlViewer = HtmlViewer;
})();
