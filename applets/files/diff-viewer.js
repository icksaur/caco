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
      // V6.1: re-render side-effects (innerHTML replacement,
      // content-shrink-clamp when the file got shorter) fire scroll
      // events that arrive AFTER our programmatic scroll guard's
      // pending entry has been consumed but before activate's rAF
      // can register a new one. Without this suppression window,
      // those phantom events get treated as user scrolls and
      // silently disable Follow Edits. _renderTick is set by
      // _render() right before innerHTML changes; we clear it two
      // animation frames later (long enough for any post-render
      // scroll storms to flush).
      if (self._renderTick) {
        self.scrollTop = st;
        return;
      }
      // Real user scroll: turn off Follow and save position.
      if (shell.getFollowEdits()) {
        shell.setFollowEdits(false);
        shell.updateFollowButton();
      }
      self.scrollTop = st;
    }, { passive: true });
  };

  DiffViewer.prototype._render = function() {
    // V6.1: arm the re-render scroll-event suppression window
    // BEFORE innerHTML changes. The scroll handler skips its
    // disable-Follow-Edits branch while this is truthy. Cleared
    // two rAFs later to cover any post-layout scroll events
    // the browser fires async.
    var self = this;
    this._renderTick = (this._renderTick || 0) + 1;
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (self.destroyed) return;
        self._renderTick = Math.max(0, (self._renderTick || 1) - 1);
      });
    });
    this.shell.renderBody(this.contentEl, this.edit);
    this.rendered = true;
    this.paintSelection();
  };

  DiffViewer.prototype.update = function(newEdit) {
    if (this.contentEqual(newEdit)) {
      this.edit = newEdit;
      return false;
    }
    // V6.1: remember the old hunks so scrollPaneToFirstDiffRow
    // can prefer a row that's NEW in this edit. Without this,
    // multi-hunk files always scroll to the topmost hunk on
    // every edit — the user's freshly-added bottom hunk stays
    // off-screen and follow-edits feels broken.
    this._prevHunkWorkRanges = this._collectWorkRanges(this.edit);
    this.edit = newEdit;
    if (this.rendered) this._render();
    return true;
  };

  /** Pure: collect [start, end] (inclusive, 1-based) work-line
   *  ranges from an edit's fullFile hunks. Used to detect which
   *  hunks are new between renders. */
  DiffViewer.prototype._collectWorkRanges = function(edit) {
    var out = [];
    var ff = edit && edit.fullFile;
    if (!ff || !Array.isArray(ff.hunks)) return out;
    for (var i = 0; i < ff.hunks.length; i++) {
      var h = ff.hunks[i];
      if (h.workLen > 0) out.push([h.workStart, h.workStart + h.workLen - 1]);
    }
    return out;
  };

  /** Return true if `line` (1-based work line) falls within ANY
   *  of the previously-rendered work-line ranges. */
  DiffViewer.prototype._wasInPrevHunks = function(line) {
    var prev = this._prevHunkWorkRanges;
    if (!prev || prev.length === 0) return false;
    for (var i = 0; i < prev.length; i++) {
      if (line >= prev[i][0] && line <= prev[i][1]) return true;
    }
    return false;
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
   *  attaches contentEl to container.contentEl.
   *  V6: opts.diffMode (unstaged | staged) carried in the request
   *  body when non-default. V6.1 dropped range. */
  DiffViewer.open = async function(shell, container, absPath, relativePath, opts) {
    opts = opts || {};
    var sid = shell.sessionId;
    var body = { relativePath: relativePath };
    if (opts.diffMode && opts.diffMode !== 'unstaged') {
      body.diffMode = opts.diffMode;
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
