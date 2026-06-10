/**
 * MarkdownViewer — ViewerInstance for rendered + editable markdown.
 *
 * V2.d: gains a 'view' ↔ 'edit' mode toggle. Edit mode replaces the
 * rendered content with a raw-text <textarea>; Save commits to disk
 * via PUT /api/files/<path>.
 *
 * Per docs/files-applet-v2.md §4.4.
 *
 * Lifecycle (extended from V1.1):
 *  - Constructor: builds detached contentEl with display:none.
 *    Allocates BOTH the rendered DOM (.md-rendered) and the editor
 *    textarea (.md-editor). Only the rendered view is visible
 *    initially; the editor is hidden until setMode('edit').
 *  - Factory open(): acquires watcher FIRST, fetches initial text,
 *    renders to DOM, attaches contentEl to container.
 *  - load() splits into _fetchDisk (raw text) and _renderToDom
 *    (DOM mutation). View mode: _fetchDisk + _renderToDom + record
 *    _diskText. Edit mode: _fetchDisk + compare with _diskText;
 *    set _diskChangedWhileEditing if different (UNLESS _saveInFlight
 *    suppresses).
 *  - setMode('edit') swaps display: shows textarea, hides rendered.
 *    Initializes editor text from _diskText.
 *  - setMode('view') from edit: prompts if isDirty; on accept
 *    swaps back and resets editor.
 *  - save(): PUT the editor text. Snapshots before PUT; on success
 *    _diskText = pendingText; on failure restores prior _diskText.
 *  - destroy() is idempotent.
 *
 * The watcher stays subscribed even when the viewer is inactive.
 * In view mode it triggers a re-render; in edit mode it triggers
 * a silent compare against _diskText and sets the
 * _diskChangedWhileEditing flag.
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

    // V2.d edit-mode state.
    this.mode = 'view';
    this._diskText = '';
    this._editorText = '';
    this._diskChangedWhileEditing = false;
    this._saveInFlight = false;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'files-tab-content files-md-content';
    this.contentEl.style.display = 'none';   // §4.0.H invariant

    // Rendered subtree (view mode).
    var inner = document.createElement('div');
    inner.className = 'md-rendered markdown-content';
    this.contentEl.appendChild(inner);
    this._mdEl = inner;

    // Editor subtree (edit mode). Hidden by default; switched on
    // via setMode('edit'). Built eagerly so the toggle is instant.
    var ta = document.createElement('textarea');
    ta.className = 'md-editor';
    ta.spellcheck = false;
    ta.style.display = 'none';
    var self = this;
    ta.addEventListener('input', function() {
      self._editorText = ta.value;
      self.shell.echoState();
    });
    ta.addEventListener('keydown', function(e) {
      // Ctrl+S / Cmd+S save shortcut.
      var key = (e.key || '').toLowerCase();
      if (key === 's' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (self.isDirty()) void self.save();
      }
    });
    this.contentEl.appendChild(ta);
    this._editEl = ta;

    // "(disk changed)" indicator. Hidden until set by the watcher
    // in edit mode.
    var diskInd = document.createElement('div');
    diskInd.className = 'md-disk-changed';
    diskInd.hidden = true;
    diskInd.textContent = '⚠ disk changed since edit started';
    this.contentEl.appendChild(diskInd);
    this._diskIndEl = diskInd;
  }

  MarkdownViewer.prototype.viewerType = 'markdown';

  MarkdownViewer.prototype.getModes = function() {
    return [
      { id: 'view', label: 'View' },
      { id: 'edit', label: 'Edit' },
    ];
  };

  MarkdownViewer.prototype.getActiveMode = function() {
    return this.mode;
  };

  MarkdownViewer.prototype.setMode = function(modeId) {
    if (this.destroyed) return;
    if (modeId === this.mode) return;
    if (modeId === 'view' && this.isDirty()) {
      if (!window.confirm('Discard unsaved changes?')) return;
      // Reset editor; refetch from disk to get the freshest content.
      this._editorText = this._diskText;
      this._editEl.value = this._diskText;
      this._diskChangedWhileEditing = false;
      this._diskIndEl.hidden = true;
      if (this.container && typeof this.container._clearChromeError === 'function') {
        this.container._clearChromeError();
      }
    }
    this.mode = modeId;
    if (modeId === 'edit') {
      this._editorText = this._diskText;
      this._editEl.value = this._diskText;
      this._mdEl.style.display = 'none';
      this._editEl.style.display = '';
      this._editEl.focus();
    } else {
      this._editEl.style.display = 'none';
      this._mdEl.style.display = '';
      this._diskChangedWhileEditing = false;
      this._diskIndEl.hidden = true;
    }
    this.shell.echoState();
  };

  MarkdownViewer.prototype.isDirty = function() {
    return this.mode === 'edit' && this._editorText !== this._diskText;
  };

  MarkdownViewer.prototype.save = async function() {
    if (this.destroyed) return;
    if (!this.isDirty()) return;
    var pendingText = this._editorText;
    var priorDisk = this._diskText;
    this._saveInFlight = true;
    this.shell.echoState();   // surfaces busy state via isDirty + activeMode
    try {
      var res = await fetch(
        '/api/files' + this.absPath.split('/').map(encodeURIComponent).join('/'),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: pendingText,
        }
      );
      if (this.destroyed) return;
      if (!res.ok) {
        var msg;
        try {
          var body = await res.json();
          msg = (body && body.error) || ('HTTP ' + res.status);
        } catch (_e) { msg = 'HTTP ' + res.status; }
        this._diskText = priorDisk;
        throw new Error(msg);
      }
      // Success: pin _diskText to what WE just wrote (NOT the live
      // _editorText, which may have moved on during the PUT).
      this._diskText = pendingText;
      this._diskChangedWhileEditing = false;
      this._diskIndEl.hidden = true;
      this.bytes = pendingText.length;
      this.shell.echoState();
    } catch (err) {
      if (this.destroyed) return;
      // Restore prior disk text so isDirty stays true → user can retry.
      this._diskText = priorDisk;
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this._saveInFlight = false;
    }
  };

  /** Fetch raw file content. Used by both view-mode render and
   *  edit-mode silent compare. */
  MarkdownViewer.prototype._fetchDisk = async function() {
    if (this._abort) this._abort.abort();
    this._abort = new AbortController();
    var signal = this._abort.signal;
    var res = await fetch(
      '/api/file?path=' + encodeURIComponent(this.absPath),
      { signal: signal }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  };

  /** Mutate the rendered DOM with markdown content. Synchronous. */
  MarkdownViewer.prototype._renderToDom = function(text) {
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
  };

  MarkdownViewer.prototype.load = async function() {
    if (this.destroyed) return;
    try {
      var text = await this._fetchDisk();
      if (this.destroyed) return;
      if (this.mode === 'edit') {
        // Edit mode: do NOT clobber the textarea. Compare with
        // _diskText; if different (and not our own save), flag it.
        if (this._saveInFlight) return;
        if (text === this._diskText) return;
        this._diskText = text;
        this._diskChangedWhileEditing = true;
        this._diskIndEl.hidden = false;
        this.shell.echoState();
      } else {
        // View mode: render + record.
        this._renderToDom(text);
        this._diskText = text;
        this.bytes = text.length;
        this.shell.echoState();
      }
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
      mode: this.mode,
    };
  };

  /** V3.x.1: declare chrome buttons. Returns the same cached
   *  array reference across calls (spec §4.1.A cache invariant).
   *  The visible/disabled predicates re-evaluate on each call.
   *  The error label "Save" prefixes any error rendered by the
   *  shell, so save() throws messages without the prefix. */
  MarkdownViewer.prototype.getChromeButtons = function() {
    var self = this;
    if (!this._chromeButtonsCache) {
      this._chromeButtonsCache = [
        {
          id: 'save',
          label: 'Save',
          title: 'Save (Ctrl+S)',
          className: 'primary',
          visible: function() { return self.isDirty(); },
          disabled: function() { return self._saveInFlight; },
          onClick: function() { return self.save(); },
        },
      ];
    }
    return this._chromeButtonsCache;
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
    if (container.destroyed || !container.contentEl) {
      inst.destroy();
      throw new Error('container destroyed during open');
    }
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.MarkdownViewer = MarkdownViewer;
})();
