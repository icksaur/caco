/**
 * DiffTab — TabInstance for git working-tree diffs.
 *
 * Extracted from FileTab in script.js (file-edits V3.5). The class
 * body is largely unchanged from the V3.5 FileTab; the V1 changes
 * are:
 *  - constructor takes a `shell` reference (replacing implicit
 *    shell-scope locals), see docs/files-applet-v1.md §4.0.3.
 *  - constructor does NOT attach `tabEl` / `contentEl` to the DOM
 *    (factory does, after the diff fetch succeeds). DOM is built
 *    detached, with `contentEl.style.display = 'none'`.
 *  - `activate()` / `deactivate()` toggle `contentEl.style.display`
 *    instead of swapping into the shared paneEl. Each DiffTab keeps
 *    its rendered content alive across tab switches.
 *  - `destroy()` is idempotent and detaches both `tabEl` and
 *    `contentEl` from the DOM.
 *
 * The `shell` API surface this class uses is enumerated in
 * docs/files-applet-v1.md §4.0.3.
 */

(function() {
  function DiffTab(shell, edit) {
    this.shell = shell;
    this.relativePath = edit.relativePath;
    this.absolutePath = edit.path || '';
    this.edit = edit;
    /** Per-tab persistent content element (the `<pre>` that holds
     *  rendered diff rows). Mounted into shell.paneEl by the
     *  factory after construction; toggled display by
     *  activate/deactivate. */
    this.contentEl = document.createElement('pre');
    this.contentEl.className = 'fe-diff files-tab-content';
    this.contentEl.style.display = 'none';   // §4.0.6 invariant
    this.scrollTop = 0;
    /** V3.4: per-tab line selection. {start, end} or null. */
    this.selection = null;
    /** V3.4: pending selection arrived via agent setState before
     *  the body was rendered. Applied on first activate(). */
    this.pendingSelection = null;
    this.destroyed = false;
    this.rendered = false;   // first render is lazy on activate()
    this.tabEl = this._buildTabEl();
  }

  DiffTab.prototype.id = '';   // set in constructor below
  DiffTab.prototype.type = 'diff';

  // Backward-compat alias: V3.5 selection code reads `tab.paneEl`.
  // In V1 the per-tab element is `contentEl`. Aliasing keeps the
  // selection / text-from-envelope sites working unchanged. The
  // alias is set up after constructor returns so the property
  // exists on every instance.
  Object.defineProperty(DiffTab.prototype, 'paneEl', {
    get: function() { return this.contentEl; },
  });

  DiffTab.prototype._buildTabEl = function() {
    var self = this;
    var shell = this.shell;
    var btn = document.createElement('button');
    btn.className = 'fe-tab fe-tab-diff';
    btn.type = 'button';
    btn.dataset.path = this.relativePath;
    btn.title = this.relativePath;

    var name = document.createElement('span');
    name.className = 'fe-tab-name';
    name.textContent = shell.basename(this.relativePath);
    btn.appendChild(name);

    var x = document.createElement('span');
    x.className = 'fe-tab-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close tab');
    btn.appendChild(x);

    btn.addEventListener('click', function(e) {
      if (e.target === x || x.contains(e.target)) {
        e.stopPropagation();
        shell.closeTab(self.relativePath);
        return;
      }
      // User clicked the tab: turn off follow, decrement badge for this
      // path (user has now seen it), activate.
      shell.setFollowEdits(false);
      shell.badgeCounter.delete(self.relativePath);
      shell.updateFollowButton();
      shell.setActiveTab(self.relativePath);
    });
    btn.addEventListener('auxclick', function(e) {
      if (e.button !== 1) return;
      e.preventDefault();
      shell.closeTab(self.relativePath);
    });
    btn.addEventListener('mousedown', function(e) {
      if (e.button === 1) e.preventDefault();
    });
    return btn;
  };

  DiffTab.prototype._render = function() {
    this.shell.renderBody(this.contentEl, this.edit);
    this.rendered = true;
    // pendingSelection is consumed by finalizeAgentSelection (post-render);
    // existing selection is repainted here so updates preserve the highlight.
    this.paintSelection();
  };

  DiffTab.prototype.update = function(newEdit) {
    if (this.contentEqual(newEdit)) {
      this.edit = newEdit;
      return false;
    }
    this.edit = newEdit;
    if (this.rendered) this._render();
    return true;
  };

  DiffTab.prototype.contentEqual = function(other) {
    var a = this.edit, b = other;
    return a && b
      && a.diff === b.diff
      && a.status === b.status
      && a.renamedFrom === b.renamedFrom
      && a.isBinary === b.isBinary
      && fullFileEqual(a.fullFile, b.fullFile);
  };

  DiffTab.prototype.paintSelection = function() {
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

  DiffTab.prototype.activate = function() {
    if (!this.rendered) this._render();
    this.contentEl.style.display = '';
    var self = this;
    requestAnimationFrame(function() {
      self.shell.programmaticScrollTo(self.scrollTop);
    });
  };

  DiffTab.prototype.deactivate = function() {
    this.scrollTop = this.shell.paneEl.scrollTop;
    this.contentEl.style.display = 'none';
  };

  DiffTab.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.tabEl && this.tabEl.parentNode) {
      this.tabEl.parentNode.removeChild(this.tabEl);
    }
    if (this.contentEl && this.contentEl.parentNode) {
      this.contentEl.parentNode.removeChild(this.contentEl);
    }
    this.edit = null;
    this.selection = null;
  };

  DiffTab.prototype.echoState = function() {
    var s = null;
    if (this.selection) {
      s = { start: this.selection.start, end: this.selection.end };
      if (typeof this.selection.text === 'string') s.text = this.selection.text;
    }
    return { kind: 'diff', path: this.relativePath, selection: s };
  };

  // The `id` property on DiffTab instances is the relative path —
  // matches today's tabs.Map key shape and the cards-endpoint id.
  Object.defineProperty(DiffTab.prototype, 'id', {
    get: function() { return this.relativePath; },
  });

  // fullFileEqual is a pure helper shared with the shell. To avoid
  // duplicating it into shell, the shell sets this on
  // __filesApplet._diffHelpers; DiffTab reads from there at module
  // load time. (The shell is loaded AFTER this file, so we deref
  // through a function rather than at module-eval time.)
  function fullFileEqual(a, b) {
    var helpers = window.__filesApplet && window.__filesApplet._diffHelpers;
    if (!helpers || typeof helpers.fullFileEqual !== 'function') {
      // Shouldn't happen — defensive fallback so a missing helper
      // doesn't crash. Treat as not-equal to force a re-render.
      return a === b;
    }
    return helpers.fullFileEqual(a, b);
  }

  window.__filesApplet = window.__filesApplet || {};
  window.__filesApplet.DiffTab = DiffTab;
})();
