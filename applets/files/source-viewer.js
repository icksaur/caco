/**
 * SourceViewer — read-only, syntax-highlighted ViewerInstance for
 * plain-text / code files.
 *
 * Used by the "external files" feature (docs/files-applet-external.md)
 * to render code/text files outside the session cwd. The diff viewer
 * cannot open external files (it requires git + cwd containment), so
 * SourceViewer provides a lightweight current-state view with hljs
 * highlighting and live-reload via the watcher.
 *
 * Lifecycle mirrors MarkdownViewer:
 *  - Constructor: builds detached contentEl <pre> with display:none.
 *  - Factory open(): acquires watcher, fetches initial text, attaches.
 *  - load(): fetch GET /api/file, highlight, set textContent.
 *  - destroy(): closes watcher, detaches DOM.
 */

(function() {
  /** Minimal binary-extension guard (subset of the main applet's
   *  isBinaryExtension). Prevents fetching obviously-binary files.
   *  Audio extensions are included so SourceViewer never claims them
   *  — keep in sync with script.js isBinaryExtension(). */
  var BINARY_RE = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar|wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i;

  /** Extension → hljs language key. Duplicated from script.js's
   *  EXT_TO_LANG (the full map lives in script.js which loads after
   *  this file; duplicating the small lookup avoids a cross-file
   *  dependency). */
  var EXT_TO_LANG = {
    'ts': 'typescript', 'tsx': 'typescript',
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'py': 'python',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
    'md': 'markdown', 'markdown': 'markdown',
    'json': 'json',
    'css': 'css', 'scss': 'css',
    'yml': 'yaml', 'yaml': 'yaml',
    'sql': 'sql',
    'c': 'cpp', 'h': 'cpp',
    'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hh': 'cpp', 'hxx': 'cpp', 'inl': 'cpp',
    'cs': 'csharp',
    'ps1': 'powershell', 'psm1': 'powershell',
    'glsl': 'glsl', 'vert': 'glsl', 'frag': 'glsl',
  };

  function detectLang(path) {
    if (!path) return null;
    var m = /\.([A-Za-z0-9_]+)$/.exec(path);
    if (!m) return null;
    return EXT_TO_LANG[m[1].toLowerCase()] || null;
  }

  function SourceViewer(shell, container, absPath, opts) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'source';
    this.destroyed = false;
    this._abort = null;
    this._watcher = null;
    this.bytes = 0;
    this._readOnly = !!(opts && opts.readOnly);

    // Edit-mode state (mirrors MarkdownViewer).
    this.mode = 'view';
    this._diskText = '';
    this._editorText = '';
    this._diskChangedWhileEditing = false;
    this._saveInFlight = false;

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'fe-source-content files-tab-content';
    this.contentEl.style.display = 'none';

    // View subtree: the syntax-highlighted <pre>.
    var pre = document.createElement('pre');
    pre.className = 'fe-source';
    this.contentEl.appendChild(pre);
    this._preEl = pre;

    // Edit subtree: raw-text editor overlay. In edit mode it sits transparently
    // over the highlighted <pre> backdrop (see setMode + .fe-editing CSS); hidden
    // in view mode. wrap='off' so it never line-wraps out of sync with the <pre>.
    var ta = document.createElement('textarea');
    ta.className = 'fe-source-editor';
    ta.spellcheck = false;
    ta.wrap = 'off';
    this._rafId = 0;
    this._lastBackdropText = null;
    var self = this;
    ta.addEventListener('input', function() {
      self._editorText = ta.value;
      self.shell.echoState();
      self._scheduleBackdrop();
    });
    ta.addEventListener('scroll', function() { self._syncScroll(); });
    ta.addEventListener('keydown', function(e) {
      var key = (e.key || '').toLowerCase();
      if (key === 's' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!self._readOnly && self.isDirty()) void self.save();
      }
    });
    this.contentEl.appendChild(ta);
    this._editEl = ta;

    // "(disk changed)" indicator, shown by the watcher when a foreign change
    // lands while editing. Reuses the markdown indicator class/positioning.
    var diskInd = document.createElement('div');
    diskInd.className = 'md-disk-changed';
    diskInd.hidden = true;
    diskInd.textContent = '⚠ disk changed since edit started';
    this.contentEl.appendChild(diskInd);
    this._diskIndEl = diskInd;
  }

  SourceViewer.prototype.viewerType = 'source';

  SourceViewer.prototype.load = async function() {
    if (this.destroyed) return;
    if (BINARY_RE.test(this.absPath || '')) {
      this._renderMessage('Binary file — cannot preview');
      return;
    }
    try {
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      var res = await fetch(
        '/api/file?path=' + encodeURIComponent(this.absPath),
        { signal: this._abort.signal }
      );
      if (this.destroyed) return;
      if (!res.ok) {
        var msg;
        if (res.status === 404) msg = 'File not found';
        else if (res.status === 403) msg = 'Permission denied';
        else if (res.status === 413) msg = 'File too large to preview';
        else msg = 'Failed to load (HTTP ' + res.status + ')';
        this._renderMessage(msg);
        return;
      }
      var text = await res.text();
      if (this.destroyed) return;
      if (this.mode === 'edit') {
        // Edit mode: don't clobber the editor. Compare with _diskText; if a
        // foreign change landed (not our own save), flag it. Mirrors markdown.
        if (this._saveInFlight) return;
        if (text === this._diskText) return;
        this._diskText = text;
        this._diskChangedWhileEditing = true;
        this._diskIndEl.hidden = false;
        this.shell.echoState();
        return;
      }
      this.bytes = text.length;
      this._diskText = text;
      this._renderToPre(text);
      this.shell.echoState();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (this.destroyed) return;
      this._renderMessage((err && err.message) || String(err));
    }
  };

  /** Build the highlighted <code> view inside the <pre>. */
  SourceViewer.prototype._renderToPre = function(text) {
    this._preEl.textContent = '';
    var code = document.createElement('code');
    code.textContent = text;
    var lang = detectLang(this.absPath);
    if (lang) code.className = 'language-' + lang;
    this._preEl.appendChild(code);
    if (typeof window.hljs !== 'undefined') {
      try { window.hljs.highlightElement(code); } catch (_e) { /* ignore */ }
    }
  };

  SourceViewer.prototype._renderMessage = function(msg) {
    this._preEl.textContent = '';
    var div = document.createElement('div');
    div.className = 'fe-source-message';
    div.textContent = msg;
    this._preEl.appendChild(div);
  };

  SourceViewer.prototype.getModes = function() {
    if (this._readOnly) return [{ id: 'view', label: 'View' }];
    return [
      { id: 'view', label: 'View' },
      { id: 'edit', label: 'Edit' },
    ];
  };

  SourceViewer.prototype.getActiveMode = function() {
    return this.mode;
  };

  SourceViewer.prototype.setMode = function(modeId) {
    if (this.destroyed) return;
    if (this._readOnly && modeId === 'edit') return;
    if (modeId === this.mode) return;
    if (modeId === 'view' && this.isDirty()) {
      if (!window.confirm('Discard unsaved changes?')) return;
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
      // Keep the <pre> visible as the highlighted backdrop; the textarea
      // overlays it transparently (.fe-editing CSS).
      this.contentEl.classList.add('fe-editing');
      this._refreshBackdrop(this._diskText);
      this._editEl.focus();
    } else {
      this.contentEl.classList.remove('fe-editing');
      this._cancelBackdrop();
      this._diskChangedWhileEditing = false;
      this._diskIndEl.hidden = true;
      // Re-render from the freshest disk text so saved/discarded content shows
      // highlighted again (and the backdrop drops its trailing-newline guard).
      this._lastBackdropText = null;
      this._renderToPre(this._diskText);
    }
    this.shell.echoState();
  };

  /** Coalesce backdrop re-highlight to one render per frame while typing. */
  SourceViewer.prototype._scheduleBackdrop = function() {
    if (this._rafId) return;
    var self = this;
    this._rafId = requestAnimationFrame(function() {
      self._rafId = 0;
      if (self.destroyed || self.mode !== 'edit') return;
      self._refreshBackdrop(self._editEl.value);
    });
  };

  SourceViewer.prototype._cancelBackdrop = function() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
  };

  /** Re-highlight the <pre> from `text`, then re-mirror scroll (a rebuild
   *  resets the <pre> scroll to 0). A trailing newline gives the final empty
   *  line height to match the textarea; only added when the text ends in \n. */
  SourceViewer.prototype._refreshBackdrop = function(text) {
    if (text !== this._lastBackdropText) {
      this._lastBackdropText = text;
      var render = (text.charAt(text.length - 1) === '\n') ? text + '\n' : text;
      this._renderToPre(render);
    }
    this._syncScroll();
  };

  SourceViewer.prototype._syncScroll = function() {
    if (!this._preEl || !this._editEl) return;
    this._preEl.scrollTop = this._editEl.scrollTop;
    this._preEl.scrollLeft = this._editEl.scrollLeft;
  };

  SourceViewer.prototype.isDirty = function() {
    return this.mode === 'edit' && this._editorText !== this._diskText;
  };

  SourceViewer.prototype.save = async function() {
    if (this._readOnly) throw new Error('read-only');
    if (this.destroyed) return;
    if (!this.isDirty()) return;
    var pendingText = this._editorText;
    var priorDisk = this._diskText;
    this._saveInFlight = true;
    this.shell.echoState();
    try {
      await window.__filesApplet.writeFileText(this.absPath, pendingText);
      if (this.destroyed) return;
      this._diskText = pendingText;
      this._diskChangedWhileEditing = false;
      this._diskIndEl.hidden = true;
      this.bytes = pendingText.length;
      this.shell.echoState();
    } catch (err) {
      if (this.destroyed) return;
      this._diskText = priorDisk;
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this._saveInFlight = false;
    }
  };

  SourceViewer.prototype.getChromeButtons = function() {
    if (this._readOnly) return [];
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

  SourceViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
    var el = this._scrollEl();
    if (el && typeof this._scrollTop === 'number') el.scrollTop = this._scrollTop;
  };
  SourceViewer.prototype.deactivate = function() {
    var el = this._scrollEl();
    if (el) this._scrollTop = el.scrollTop;
    this.contentEl.style.display = 'none';
  };

  /** The active scroller: the textarea in edit mode, the <pre> in view mode. */
  SourceViewer.prototype._scrollEl = function() {
    return this.mode === 'edit' ? this._editEl : this._preEl;
  };

  /** C1 editor-state restore. */
  SourceViewer.prototype.getScrollState = function() {
    if (this.contentEl.style.display === 'none') return this._scrollTop || 0;
    var el = this._scrollEl();
    return el ? el.scrollTop : 0;
  };
  SourceViewer.prototype.setScrollState = function(n) {
    this._scrollTop = n || 0;
    if (this.contentEl.style.display !== 'none') {
      var el = this._scrollEl();
      if (el) el.scrollTop = this._scrollTop;
    }
  };

  SourceViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._cancelBackdrop();
    if (this._abort) { try { this._abort.abort(); } catch (_e) { /* ignore */ } }
    if (this._watcher) {
      try { Promise.resolve(this._watcher.close()).catch(function(){}); }
      catch (_e) { /* ignore */ }
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
  };

  SourceViewer.prototype.echoState = function() {
    return {
      kind: 'source',
      path: this.absPath,
      readOnly: this._readOnly,
      loaded: this.bytes > 0,
      size: this.bytes,
      mode: this.mode,
    };
  };

  SourceViewer.open = async function(shell, container, absPath, _relPath, opts) {
    var inst = new SourceViewer(shell, container, absPath, opts);
    if (BINARY_RE.test(absPath || '')) {
      inst._renderMessage('Binary file — cannot preview');
      if (container.destroyed || !container.contentEl) {
        inst.destroy();
        throw new Error('container destroyed during open');
      }
      container.contentEl.appendChild(inst.contentEl);
      return inst;
    }
    try {
      if (!opts || opts.watch !== false) {
        inst._watcher = await shell.api.watchPath(absPath, { scope: 'file' });
        if (inst.destroyed) {
          try { inst._watcher.close(); } catch (_e) { /* ignore */ }
          throw new Error('aborted');
        }
        inst._watcher.onChange(function() { void inst.load(); });
      }
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
  window.__filesApplet.SourceViewer = SourceViewer;
})();
