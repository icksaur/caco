/**
 * DiffViewer — ViewerInstance for git working-tree diffs.
 *
 * V1.1: renamed from DiffTab. The class no longer owns its tab
 * button (TabContainer does); it owns only its content subtree
 * (a child of TabContainer.contentEl) and the per-viewer state
 * (selection, scrollTop, edit). See docs/files-applet-v1.1.md
 * §4.0.C / §4.0.D.
 *
 * The viewer is the **scroll container** for its content: the
 * outer pane no longer scrolls. The toggle button (owned by
 * TabContainer) is positioned absolutely OVER the viewer and
 * does not scroll with it.
 *
 * V3.5 selection-code compat: an `paneEl` getter on
 * DiffViewer.prototype aliases `contentEl` so existing line-
 * envelope helpers in script.js (which V1.1 Step 5 re-routes
 * through `activeDiffViewer(container)`) continue to read
 * `diff.paneEl`.
 */

(function() {
  function DiffViewer(shell, container, edit) {
    this.shell = shell;
    this.container = container;
    this.relativePath = edit.relativePath;
    this.absolutePath = edit.path || '';
    this.edit = edit;
    this.contentEl = document.createElement('pre');
    this.contentEl.className = 'fe-diff files-tab-content';
    this.contentEl.style.display = 'none';   // §4.0.H invariant
    this.scrollTop = 0;
    this.selection = null;
    this.pendingSelection = null;
    this.destroyed = false;
    this.rendered = false;
    this._installScrollHandler();
  }

  DiffViewer.prototype.viewerType = 'diff';

  // V3.5 compat alias.
  Object.defineProperty(DiffViewer.prototype, 'paneEl', {
    get: function() { return this.contentEl; },
  });

  DiffViewer.prototype._installScrollHandler = function() {
    var self = this;
    var shell = this.shell;
    this.contentEl.addEventListener('scroll', function() {
      if (self.destroyed) return;
      var st = self.contentEl.scrollTop;
      if (shell.consumeProgrammaticScroll(self.contentEl, st)) return;
      // Real user scroll: turn off Follow and save position.
      if (shell.getFollowEdits()) {
        shell.setFollowEdits(false);
        shell.updateFollowButton();
      }
      self.scrollTop = st;
    }, { passive: true });
  };

  DiffViewer.prototype._render = function() {
    this.shell.renderBody(this.contentEl, this.edit);
    this.rendered = true;
    this.paintSelection();
  };

  DiffViewer.prototype.update = function(newEdit) {
    if (this.contentEqual(newEdit)) {
      this.edit = newEdit;
      return false;
    }
    this.edit = newEdit;
    if (this.rendered) this._render();
    return true;
  };

  DiffViewer.prototype.contentEqual = function(other) {
    var a = this.edit, b = other;
    return a && b
      && a.diff === b.diff
      && a.status === b.status
      && a.renamedFrom === b.renamedFrom
      && a.isBinary === b.isBinary
      && fullFileEqual(a.fullFile, b.fullFile);
  };

  DiffViewer.prototype.paintSelection = function() {
    if (!this.rendered) return;
    var existing = this.contentEl.querySelectorAll('.fe-row-selected');
    for (var i = 0; i < existing.length; i++) {
      existing[i].classList.remove('fe-row-selected');
    }
    if (!this.selection) return;
    var rows = this.contentEl.querySelectorAll('.fe-row[data-work-line]');
    for (var j = 0; j < rows.length; j++) {
      var n = parseInt(rows[j].dataset.workLine, 10);
      if (n >= this.selection.start && n <= this.selection.end) {
        rows[j].classList.add('fe-row-selected');
      }
    }
  };

  DiffViewer.prototype.activate = function() {
    if (!this.rendered) this._render();
    this.contentEl.style.display = '';
    var self = this;
    requestAnimationFrame(function() {
      if (self.destroyed) return;
      self.shell.programmaticScrollTo(self.contentEl, self.scrollTop);
    });
  };

  DiffViewer.prototype.deactivate = function() {
    if (this.contentEl) this.scrollTop = this.contentEl.scrollTop;
    this.contentEl.style.display = 'none';
  };

  DiffViewer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
    this.edit = null;
    this.selection = null;
    this.pendingSelection = null;
  };

  DiffViewer.prototype.echoState = function() {
    var s = null;
    if (this.selection) {
      s = { start: this.selection.start, end: this.selection.end };
      if (typeof this.selection.text === 'string') s.text = this.selection.text;
    }
    return { kind: 'diff', path: this.relativePath, selection: s };
  };

  /** V6: chrome refresh button for staged + range tabs (snapshots
   *  that the poller doesn't auto-update). Unstaged tabs return an
   *  empty array because caco.edit already keeps them live.
   *  Contract per applets/files/script.js:461-571. */
  DiffViewer.prototype.getChromeButtons = function() {
    var mode = this.container && this.container.diffMode;
    if (mode !== 'staged' && mode !== 'range') return [];
    var self = this;
    return [{
      id: 'reload',
      label: '↻',
      title: 'Refresh snapshot',
      visible: function() { return true; },
      disabled: function() { return self._reloading === true; },
      onClick: function() { return self.reload(); },
    }];
  };

  /** V6: re-run the mode-aware DiffViewer.open fetch in place and
   *  re-render. Used by the refresh chrome button. Safe to call
   *  while a previous reload is in flight (early-return via
   *  _reloading guard). */
  DiffViewer.prototype.reload = async function() {
    if (this.destroyed || this._reloading) return;
    this._reloading = true;
    this.shell.echoState();
    try {
      var sid = this.shell.sessionId;
      var body = { relativePath: this.relativePath };
      if (this.container.diffMode && this.container.diffMode !== 'unstaged') {
        body.diffMode = this.container.diffMode;
        if (this.container.diffMode === 'range') body.ref = this.container.diffRef || '';
      }
      var res = await fetch(
        '/api/sessions/' + encodeURIComponent(sid) + '/file-edits/open',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (this.destroyed) return;
      if (!res.ok) throw new Error('reload failed: HTTP ' + res.status);
      var data = await res.json();
      if (this.destroyed) return;
      if (!data.edit) throw new Error('no edit returned');
      this.edit = data.edit;
      if (this.rendered) this._render();
      this.shell.echoState();
    } finally {
      this._reloading = false;
      this.shell.echoState();
    }
  };

  /** Factory: V1.1 routeOpen path. Fetches the edit, constructs,
   *  attaches contentEl to container.contentEl. */
  DiffViewer.open = async function(shell, container, absPath, relativePath, opts) {
    opts = opts || {};
    var sid = shell.sessionId;
    var body = { relativePath: relativePath };
    if (opts.diffMode && opts.diffMode !== 'unstaged') {
      body.diffMode = opts.diffMode;
      if (opts.diffMode === 'range') body.ref = opts.ref || '';
    }
    var res = await fetch(
      '/api/sessions/' + encodeURIComponent(sid) + '/file-edits/open',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error('open failed: HTTP ' + res.status);
    var data = await res.json();
    if (!data.edit) throw new Error('no edit returned');
    if (sid !== shell.sessionId) throw new Error('session changed');
    if (container.destroyed || !container.contentEl) {
      throw new Error('container destroyed during open');
    }
    var inst = new DiffViewer(shell, container, data.edit);
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  /** Convenience: construct directly from a pre-fetched edit
   *  (used by openOrUpdateTab + applyAgentState + cards rehydrate
   *  which already have the payload). Attaches contentEl. */
  DiffViewer.fromEdit = function(shell, container, edit) {
    var inst = new DiffViewer(shell, container, edit);
    container.contentEl.appendChild(inst.contentEl);
    return inst;
  };

  function fullFileEqual(a, b) {
    var helpers = window.__filesApplet && window.__filesApplet._diffHelpers;
    if (!helpers || typeof helpers.fullFileEqual !== 'function') return a === b;
    return helpers.fullFileEqual(a, b);
  }

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.DiffViewer = DiffViewer;
})();
