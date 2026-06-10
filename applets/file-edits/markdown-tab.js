/**
 * MarkdownTab — TabInstance for rendered markdown files.
 *
 * Port of applets/markdown-viewer/script.js into the V1 tab
 * contract (docs/files-applet-v1.md §4.5). Subscribes to
 * appletAPI.watchPath for live re-render on external edit.
 *
 * Lifecycle:
 *  - Constructor builds detached DOM (`tabEl` + `contentEl` with
 *    `display:none`) and initializes fields. No I/O, no DOM attach.
 *  - Static `open(shell, absPath)` factory:
 *      1. acquires the watcher FIRST (so a write during the
 *         initial fetch is not silently dropped),
 *      2. wires watcher.onChange to load(),
 *      3. performs the initial load(),
 *      4. on success, attaches tabEl/contentEl to the shell,
 *      5. on rejection, destroys the partial instance and
 *         re-throws.
 *  - `load()` is AbortController-guarded: concurrent calls cancel
 *    each other so only the latest fetch reaches the DOM.
 *  - `destroy()` is idempotent: sets `destroyed=true`, aborts
 *    fetches, closes the watcher, detaches DOM.
 */

(function() {
  function MarkdownTab(shell, absPath) {
    this.shell = shell;
    this.absPath = absPath;
    this.type = 'markdown';
    this.id = 'markdown:' + absPath;
    this.label = shell.basename(absPath);
    this.title = absPath;
    this.bytes = 0;
    this.destroyed = false;
    this._abort = null;
    this._watcher = null;

    this.tabEl = this._buildTabEl();
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-md-content';
    this.contentEl.style.display = 'none';   // §4.0.6 invariant
    var inner = document.createElement('div');
    inner.className = 'md-rendered markdown-content';
    this.contentEl.appendChild(inner);
    this._mdEl = inner;
  }

  MarkdownTab.prototype._buildTabEl = function() {
    var self = this;
    var shell = this.shell;
    var btn = document.createElement('button');
    btn.className = 'fe-tab fe-tab-md';
    btn.type = 'button';
    btn.dataset.path = this.absPath;
    btn.title = this.absPath;

    var name = document.createElement('span');
    name.className = 'fe-tab-name';
    name.textContent = this.label;
    btn.appendChild(name);

    var x = document.createElement('span');
    x.className = 'fe-tab-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close tab');
    btn.appendChild(x);

    btn.addEventListener('click', function(e) {
      if (e.target === x || x.contains(e.target)) {
        e.stopPropagation();
        shell.closeTab(self.id);
        return;
      }
      shell.setActiveTab(self.id);
    });
    btn.addEventListener('auxclick', function(e) {
      if (e.button !== 1) return;
      e.preventDefault();
      shell.closeTab(self.id);
    });
    btn.addEventListener('mousedown', function(e) {
      if (e.button === 1) e.preventDefault();
    });
    return btn;
  };

  MarkdownTab.prototype.load = async function() {
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

  MarkdownTab.prototype._renderError = function(msg) {
    this._mdEl.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'error';
    div.textContent = 'Error: ' + msg;
    this._mdEl.appendChild(div);
  };

  MarkdownTab.prototype.echoState = function() {
    return {
      kind: 'markdown',
      path: this.absPath,
      loaded: this.bytes > 0,
      size: this.bytes,
    };
  };

  MarkdownTab.prototype.activate = function() {
    this.contentEl.style.display = '';
  };
  MarkdownTab.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
  };

  MarkdownTab.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._abort) { try { this._abort.abort(); } catch (_e) { /* ignore */ } }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function(){}); }
      catch (_e) { /* ignore */ }
    }
    if (this.tabEl && this.tabEl.parentNode) {
      this.tabEl.parentNode.removeChild(this.tabEl);
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  MarkdownTab.open = async function(shell, absPath, _relPath) {
    var inst = new MarkdownTab(shell, absPath);
    try {
      // Acquire watcher FIRST so a write during the initial load()
      // is not silently dropped. No client-side debounce — server
      // coalesces at 150ms in src/watch-store.ts.
      inst._watcher = await shell.api.watchPath(absPath, { scope: 'file' });
      if (inst.destroyed) {   // race: destroyed during watch acquire
        try { inst._watcher.close(); } catch (_e) { /* ignore */ }
        throw new Error('aborted');
      }
      inst._watcher.onChange(function() { void inst.load(); });
      await inst.load();
      if (inst.destroyed) throw new Error('aborted');
    } catch (err) {
      inst.destroy();   // safe: nothing attached yet
      throw err;
    }
    // All awaits succeeded — attach DOM. State: mounted-inactive.
    shell.tabStripEl.appendChild(inst.tabEl);
    shell.paneEl.appendChild(inst.contentEl);
    return inst;
  };

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.MarkdownTab = MarkdownTab;
})();
