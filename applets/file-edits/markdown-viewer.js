/**
 * MarkdownViewer — ViewerInstance for rendered markdown.
 *
 * V1.1: renamed from MarkdownTab. The class no longer owns its
 * tab button (TabContainer does); it owns only its content
 * subtree (a child of TabContainer.contentEl) and the per-viewer
 * state (watcher, in-flight fetch, bytes).
 *
 * See docs/files-applet-v1.1.md §4.0.C / §4.0.D / §4.5.
 *
 * Lifecycle (unchanged from V1):
 *  - Constructor: synchronous, builds detached contentEl with
 *    display:none.
 *  - Factory open(): acquires watcher FIRST, awaits initial load,
 *    attaches contentEl to container.contentEl on success or
 *    destroys + re-throws on failure.
 *  - load() is AbortController-guarded; destroyed-flag bailed
 *    after every await.
 *  - destroy() is idempotent.
 *
 * The watcher remains subscribed even when the viewer is inactive
 * (e.g. user toggled to DiffViewer). load() continues to fire on
 * file changes and updates the (display:none) DOM, so toggle-back
 * sees current content with no extra reload (spec §7.4 Q5).
 */

(function() {
  function MarkdownViewer(shell, container, absPath) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'markdown';
    this.bytes = 0;
    this.destroyed = false;
    this._abort = null;
    this._watcher = null;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-md-content';
    this.contentEl.style.display = 'none';   // §4.0.H invariant
    var inner = document.createElement('div');
    inner.className = 'md-rendered markdown-content';
    this.contentEl.appendChild(inner);
    this._mdEl = inner;
  }

  MarkdownViewer.prototype.viewerType = 'markdown';

  MarkdownViewer.prototype.load = async function() {
    if (this.destroyed) return;
    if (this._abort) this._abort.abort();
    this._abort = new AbortController();
    var signal = this._abort.signal;
    try {
      var res = await fetch(
        '/api/file?path=' + encodeURIComponent(this.absPath),
        { signal: signal }
      );
      if (this.destroyed) return;
      if (!res.ok) { this._renderError('HTTP ' + res.status); return; }
      var text = await res.text();
      if (this.destroyed) return;
      this._mdEl.textContent = text;
      if (typeof window.renderMarkdownElement === 'function') {
        window.renderMarkdownElement(this._mdEl);
      }
      if (typeof window.hljs !== 'undefined') {
        var blocks = this._mdEl.querySelectorAll('pre code');
        for (var i = 0; i < blocks.length; i++) {
          try { window.hljs.highlightElement(blocks[i]); } catch (_e) { /* ignore */ }
        }
      }
      this.bytes = text.length;
      this.shell.echoState();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (this.destroyed) return;
      this._renderError((err && err.message) || String(err));
    }
  };

  MarkdownViewer.prototype._renderError = function(msg) {
    this._mdEl.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'error';
    div.textContent = 'Error: ' + msg;
    this._mdEl.appendChild(div);
  };

  MarkdownViewer.prototype.echoState = function() {
    return {
      kind: 'markdown',
      path: this.absPath,
      loaded: this.bytes > 0,
      size: this.bytes,
    };
  };

  MarkdownViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
  };
  MarkdownViewer.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
  };

  MarkdownViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._abort) { try { this._abort.abort(); } catch (_e) { /* ignore */ } }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function(){}); }
      catch (_e) { /* ignore */ }
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  MarkdownViewer.open = async function(shell, container, absPath, _relPath) {
    var inst = new MarkdownViewer(shell, container, absPath);
    try {
      inst._watcher = await shell.api.watchPath(absPath, { scope: 'file' });
      if (inst.destroyed) {
        try { inst._watcher.close(); } catch (_e) { /* ignore */ }
        throw new Error('aborted');
      }
      inst._watcher.onChange(function() { void inst.load(); });
      await inst.load();
      if (inst.destroyed) throw new Error('aborted');
    } catch (err) {
      inst.destroy();
      throw err;
    }
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.MarkdownViewer = MarkdownViewer;
})();
