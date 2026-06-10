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

  /** Factory: V1.1 routeOpen path. Fetches the edit, constructs,
   *  attaches contentEl to container.contentEl. */
  DiffViewer.open = async function(shell, container, absPath, relativePath) {
    var sid = shell.sessionId;
    var res = await fetch(
      '/api/sessions/' + encodeURIComponent(sid) + '/file-edits/open',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: relativePath }),
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
