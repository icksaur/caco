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
   *  isBinaryExtension). Prevents fetching obviously-binary files. */
  var BINARY_RE = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar)$/i;

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

  function SourceViewer(shell, container, absPath) {
    this.shell = shell;
    this.container = container;
    this.absPath = absPath;
    this.viewerType = 'source';
    this.destroyed = false;
    this._abort = null;
    this._watcher = null;
    this.bytes = 0;

    this.contentEl = document.createElement('pre');
    this.contentEl.className = 'fe-source files-tab-content';
    this.contentEl.style.display = 'none';
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
      this.bytes = text.length;

      // Build a <code> element for hljs, wrapped inside the <pre>.
      this.contentEl.textContent = '';
      var code = document.createElement('code');
      code.textContent = text;
      var lang = detectLang(this.absPath);
      if (lang) code.className = 'language-' + lang;
      this.contentEl.appendChild(code);

      if (typeof window.hljs !== 'undefined') {
        try { window.hljs.highlightElement(code); } catch (_e) { /* ignore */ }
      }
      this.shell.echoState();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (this.destroyed) return;
      this._renderMessage((err && err.message) || String(err));
    }
  };

  SourceViewer.prototype._renderMessage = function(msg) {
    this.contentEl.textContent = '';
    var div = document.createElement('div');
    div.className = 'fe-source-message';
    div.textContent = msg;
    this.contentEl.appendChild(div);
  };

  SourceViewer.prototype.activate = function() {
    this.contentEl.style.display = '';
  };
  SourceViewer.prototype.deactivate = function() {
    this.contentEl.style.display = 'none';
  };

  SourceViewer.prototype.destroy = function() {
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

  SourceViewer.prototype.echoState = function() {
    return {
      kind: 'source',
      path: this.absPath,
      readOnly: true,
      loaded: this.bytes > 0,
      size: this.bytes,
    };
  };

  SourceViewer.open = async function(shell, container, absPath, _relPath, opts) {
    var inst = new SourceViewer(shell, container, absPath);
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
