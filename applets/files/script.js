/**
 * File Edits applet — V3.2 (tabs + always-on edits).
 *
 * See docs/file-edits-v3.2.md. The UI is a tab strip + single content
 * pane. Tabs auto-open on agent edits (or user pick via +). A
 * `followEdits` boolean decides whether incoming edits auto-switch
 * tabs; user gestures (tab click, pane scroll, picker) turn it off;
 * the top-center "Follow edits" button turns it back on and jumps to
 * the most recent edit.
 *
 * Persisted state (per session, V2.1 mechanism): tab order. Reuses
 * the V2.1 cards endpoint and JSON shape; writes empty dismissed[]
 * and collapsed=false. Active-tab id is NOT persisted in V3.2.
 */

(function() {
  var repoEl = document.getElementById('feRepo');
  var followBtn = document.getElementById('feFollow');
  var openBtn = document.getElementById('feOpen');
  var tabsEl = document.getElementById('feTabs');
  var paneEl = document.getElementById('fePane');
  var paneEmptyEl = document.getElementById('fePaneEmpty');
  var notGitEl = document.getElementById('feNotGit');
  var rootEl = paneEl.parentNode;

  // ── State machine ─────────────────────────────────────────────────────
  var followEdits = true;
  var activeTabId = null;
  /** Map<tabId, TabInstance>. Map iteration order = insertion order =
   *  tab strip order (left-to-right). Tabs never reorder after creation.
   *  V1.1: TabInstance is a TabContainer wrapping one or more
   *  ViewerInstances. id == relativePath for diff-default
   *  containers; 'markdown:'+absPath for markdown-default.
   *  See docs/files-applet-v1.1.md §4.0.C. */
  var tabs = new Map();
  /** Most recent tab to receive a content-changing edit (not no-op). Drives
   *  jumpToMostRecent's primary target. */
  var lastEditedTabId = null;
  /** Distinct paths edited while followEdits was false. Drives Follow
   *  button's N-badge. Cleared on Follow-click and session change. */
  var badgeCounter = new Set();
  /** Paths the user has explicitly dismissed via close (X, middle-click).
   *  Filtered out of incoming caco.edit broadcasts so the poller's
   *  current-state re-emission doesn't re-create just-closed tabs.
   *  An entry is removed when the file becomes clean (status==='clean')
   *  in a subsequent broadcast OR when a NEW edit arrives for it AFTER
   *  the dismiss (signalled by content changing vs the cached
   *  snapshot — see dismissedSnapshots below).
   *
   *  Cleared on session-switch. */
  var dismissedPaths = new Set();
  /** path → { diff, status, isBinary } snapshot at dismiss time.
   *  Used to detect "new edit happened" so dismissed tabs auto-reopen
   *  on genuine new agent/user activity but stay closed for the
   *  poller's redundant re-broadcasts. */
  var dismissedSnapshots = new Map();
  /** Single-shot suppression flag for pane scroll. Set by code that does
   *  a programmatic scrollTop write; consumed by the scroll handler. */
  /** Value-comparison guard for programmatic scroll writes. The bool
   *  single-shot can be burned by spurious events (visibility flicker,
   *  rAF ordering, double-write from setActiveTab + caller-set-0).
   *  Store the target value the writer asked for; consume only when
   *  the observed scrollTop is within ±1px. Supports any number of
   *  scroll events firing between write and observation.
   *
   *  V1.1: scrolling moved from .fe-pane to per-viewer contentEls,
   *  so the guard is now keyed by element. */
  var pendingProgrammaticScrolls = new WeakMap();   // element → { target }
  function programmaticScrollTo(element, target) {
    if (!element) return;
    var maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    var clamped = Math.max(0, Math.min(target, maxScroll));
    pendingProgrammaticScrolls.set(element, { target: clamped });
    element.scrollTop = clamped;
  }
  function consumeProgrammaticScroll(element, observedTop) {
    var pending = pendingProgrammaticScrolls.get(element);
    if (pending && Math.abs(observedTop - pending.target) <= 1) {
      pendingProgrammaticScrolls.delete(element);
      return true;
    }
    return false;
  }
  var sessionId = null;
  var cachedCwd = '';
  var TAB_CAP = 50;

  // V3.y.1: deep-link queue. cold-load fires onUrlParamsChange
  // before cachedCwd is set; queue the openPath and drain when
  // cachedCwd arrives. See docs/files-applet-v3.y.md §4.1.B.
  // V6: pending entry carries optional routeOpen opts (diffMode)
  // so a cold-load ?diffMode=staged URL doesn't lose its mode
  // when drained after cachedCwd lands.
  var _pendingOpenPath = null;
  function _handleOpenPath(p, opts) {
    if (!p) return;
    var relPath = _relativizePath(p);
    void routeOpen(relPath, opts || {});
  }
  function _relativizePath(absOrRel) {
    if (!absOrRel) return '';
    if (absOrRel.charAt(0) !== '/') return absOrRel;
    if (!cachedCwd) return absOrRel;
    if (absOrRel === cachedCwd) return '';
    var prefix = cachedCwd.replace(/\/+$/, '') + '/';
    if (absOrRel.indexOf(prefix) === 0) return absOrRel.slice(prefix.length);
    return absOrRel;
  }
  function _drainPendingOpenPath() {
    if (_pendingOpenPath && cachedCwd) {
      var pending = _pendingOpenPath;
      _pendingOpenPath = null;
      // Back-compat: pre-V6 sites stored a bare string in
      // _pendingOpenPath. Tolerate it so any in-flight transition
      // doesn't crash; new sites always store { path, opts }.
      var p = typeof pending === 'string' ? pending : pending.path;
      var opts = typeof pending === 'string' ? undefined : pending.opts;
      _handleOpenPath(p, opts);
    }
  }

  // ── DiffViewer + MarkdownViewer (loaded by sibling .js files) ────────
  // Concatenated by applet-store.ts before this script. Exposed at
  // window.__filesApplet.DiffViewer / .MarkdownViewer.
  // See docs/files-applet-v1.1.md §4.0.B.
  var DiffViewer = window.__filesApplet && window.__filesApplet.DiffViewer;
  var MarkdownViewer = window.__filesApplet && window.__filesApplet.MarkdownViewer;
  var ImageViewer = window.__filesApplet && window.__filesApplet.ImageViewer;
  var HtmlViewer = window.__filesApplet && window.__filesApplet.HtmlViewer;
  if (!DiffViewer) console.error('[files-applet] diff-viewer.js did not load');
  if (!MarkdownViewer) console.error('[files-applet] markdown-viewer.js did not load');
  if (!ImageViewer) console.warn('[files-applet] image-viewer.js did not load');
  if (!HtmlViewer) console.warn('[files-applet] html-viewer.js did not load');

  function basename(p) {
    var i = p.lastIndexOf('/');
    if (i < 0) i = p.lastIndexOf('\\');
    return i < 0 ? p : p.slice(i + 1);
  }

  /** V2.a (spec §4.0.A): file extensions DiffViewer refuses to
   *  handle. Binary content (and SVG, whose diff is line-noise)
   *  routes to ImageViewer / HtmlViewer / future viewers instead.
   *  See spec §7.7 Q7 for why SVG is listed. */
  function isBinaryExtension(rel) {
    return /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar)$/i.test(rel || '');
  }

  /** V6: collision-safe tab id for diff tabs. NUL sentinels
   *  cannot appear in real relPaths (API rejects at
   *  src/routes/file-edits.ts:72), so the prefixed form cannot
   *  collide with any user-supplied path.
   *  V6.1: simplified — only unstaged + staged.
   */
  function diffTabId(opts) {
    var mode = (opts && opts.mode) || 'unstaged';
    var rel = (opts && opts.relPath) || '';
    if (mode === 'staged') return '\u0000diff-staged\u0000' + rel;
    return rel;
  }

  // ── Viewer registry ──────────────────────────────────────────────────
  // V1.1: replaces V1's tabTypes registry. Each ViewerDescriptor adds
  // isDefault(abs, rel) on top of canHandle. See spec §4.0.B.
  var viewerRegistry = [];
  function registerViewer(desc) { viewerRegistry.push(desc); }

  /** Pick the default viewer for a path: first isDefault match, else
   *  first canHandle match, else null. */
  function defaultViewer(absPath, relPath) {
    for (var i = 0; i < viewerRegistry.length; i++) {
      if (viewerRegistry[i].isDefault(absPath, relPath)) return viewerRegistry[i];
    }
    for (var j = 0; j < viewerRegistry.length; j++) {
      if (viewerRegistry[j].canHandle(absPath, relPath)) return viewerRegistry[j];
    }
    return null;
  }

  /** Find a container by its relPath. V6: accepts an optional
   *  { mode } filter so the poller's caco.edit lookup never
   *  matches a staged tab, and user-initiated opens find
   *  the exact requested tab (not whichever same-path tab
   *  happens to exist first). See docs/files-applet-v6.md §4.3.1.
   */
  function findContainerByRelPath(relPath, opts) {
    opts = opts || {};
    // V6.1: simplified to mode-only after range was removed.
    // null means "don't filter on mode", non-null = exact match.
    var wantMode = opts.mode !== undefined ? opts.mode : null;
    var found = null;
    tabs.forEach(function(c) {
      if (found) return;
      if (c.relPath !== relPath) return;
      if (wantMode !== null && c.diffMode !== wantMode) return;
      found = c;
    });
    return found;
  }

  /** Active diff viewer of a container, or null. Used by the V3.5
   *  selection-code adaptation (spec §4.6). */
  function activeDiffViewer(container) {
    if (!container || container.activeViewerType !== 'diff') return null;
    return container.viewers.get('diff') || null;
  }

  // ── Shell object — see docs/files-applet-v1.1.md §4.0.3 + §4.6 ───────
  /** V3.x.2 eviction config. Read from localStorage at init; null
   *  means disabled. See docs/files-applet-v3.x.md §4.2.A. */
  var _evictionTimeoutMs = null;
  try {
    var _evictRaw = window.localStorage && window.localStorage.getItem(
      'caco:files-applet:inactiveViewerTimeoutMs');
    if (_evictRaw != null) {
      var _evictParsed = parseInt(_evictRaw, 10);
      if (!isNaN(_evictParsed) && _evictParsed > 0) _evictionTimeoutMs = _evictParsed;
    }
  } catch (_e) { /* localStorage may be blocked */ }

  var shell = {
    api: window.appletAPI,
    paneEl: paneEl,
    tabStripEl: tabsEl,
    basename: basename,
    badgeCounter: badgeCounter,
    viewers: viewerRegistry,
    get sessionId() { return sessionId; },
    closeTab: function(id) { closeTab(id); },
    setActiveTab: function(id) { setActiveTab(id); },
    echoState: function() { echoState(); },
    // V3.x.2: opt-in inactive-viewer eviction. Default null (off).
    getEvictionTimeoutMs: function() { return _evictionTimeoutMs; },
    // Element-keyed programmatic-scroll API (V1.1 — scrolling moved
    // from .fe-pane to per-viewer contentEls):
    programmaticScrollTo: programmaticScrollTo,
    consumeProgrammaticScroll: consumeProgrammaticScroll,
    // DiffViewer-only helpers (see §4.0.3 last row):
    updateFollowButton: function() { updateFollowButton(); },
    renderBody: function(body, edit) { renderBody(body, edit); },
    getFollowEdits: function() { return followEdits; },
    setFollowEdits: function(v) { followEdits = v; },
  };

  // ── TabContainer ─────────────────────────────────────────────────────
  // A tab in the strip + its content pane root. Holds a map of viewers
  // (lazy-constructed). Owns tabEl + outer contentEl + toggle button.
  // See spec §4.0.C.
  function TabContainer(shellRef, descriptor, absPath, relPath) {
    this.shell = shellRef;
    this.absPath = absPath;
    this.relPath = relPath;
    this.defaultViewerType = descriptor.viewerType;
    this.activeViewerType = descriptor.viewerType;
    // V6: diff tabs carry mode so id and lookups can disambiguate
    // working-tree from staged tabs for the same file. Non-diff
    // tabs leave it at default. V6.1 removed diffRef.
    this.diffMode = descriptor.diffMode || 'unstaged';
    // Stable id:
    //   - markdown: 'markdown:' + absPath (V1 schema)
    //   - diff (default unstaged): relPath (V1 schema)
    //   - V6 diff staged: diffTabId with NUL sentinels
    if (descriptor.viewerType === 'markdown') {
      this.id = 'markdown:' + absPath;
    } else {
      this.id = diffTabId({ mode: this.diffMode, relPath: relPath });
    }
    this.label = basename(relPath || absPath);
    this.viewers = new Map();
    this.switching = false;
    this.destroyed = false;
    /** V3.x.2: per-viewerType eviction setTimeout ids. */
    this._evictionTimers = new Map();

    var self = this;

    // Tab button (in the strip).
    var btn = document.createElement('button');
    btn.className = 'fe-tab fe-tab-' + descriptor.viewerType;
    btn.type = 'button';
    btn.dataset.path = this.id;
    // V6: title reflects mode so a hover discloses staged.
    btn.title = this.diffMode === 'staged' ? (relPath + ' (staged)') : relPath;
    var name = document.createElement('span');
    name.className = 'fe-tab-name';
    name.textContent = this.label;
    btn.appendChild(name);
    // V6: dim ' · staged' suffix so the basename stays the dominant
    // glyph but the user can tell modes apart at a glance.
    if (this.diffMode === 'staged') {
      var suffix = document.createElement('span');
      suffix.className = 'fe-tab-mode';
      suffix.textContent = ' · staged';
      btn.appendChild(suffix);
    }
    var x = document.createElement('span');
    x.className = 'fe-tab-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close tab');
    btn.appendChild(x);
    btn.addEventListener('click', function(e) {
      if (e.target === x || x.contains(e.target)) {
        e.stopPropagation();
        shellRef.closeTab(self.id);
        return;
      }
      // §4.8: always disable follow + clear badge, regardless of default type.
      shellRef.setFollowEdits(false);
      shellRef.badgeCounter.delete(self.relPath);
      shellRef.updateFollowButton();
      shellRef.setActiveTab(self.id);
    });
    btn.addEventListener('auxclick', function(e) {
      if (e.button !== 1) return;
      e.preventDefault();
      shellRef.closeTab(self.id);
    });
    btn.addEventListener('mousedown', function(e) {
      if (e.button === 1) e.preventDefault();
    });
    this.tabEl = btn;

    // Outer content pane (per-tab). Position: relative so the toggle
    // can absolutely-anchor to its viewport. overflow: hidden so the
    // viewer's own scrollbar is the only scroll surface.
    var pane = document.createElement('div');
    pane.className = 'files-tab-pane';
    pane.style.display = 'none';   // §4.0.H invariant
    this.contentEl = pane;

    // Toggle button (top-right floating). Visibility controlled by
    // updateToggle().
    var toggle = document.createElement('button');
    toggle.className = 'files-viewer-toggle';
    toggle.type = 'button';
    toggle.hidden = true;
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var target = toggle.dataset.target;
      if (target) void self.switchViewer(target);
    });
    pane.appendChild(toggle);
    this.toggleBtn = toggle;

    // V2.d: Mode toggle. Lazy-shown when the active viewer's
    // getModes() returns ≥2 entries. Stacked below the viewer
    // toggle. See docs/files-applet-v2.md §4.0.C / §4.4.3.
    var modeBtn = document.createElement('button');
    modeBtn.className = 'files-mode-toggle';
    modeBtn.type = 'button';
    modeBtn.hidden = true;
    modeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var targetMode = modeBtn.dataset.target;
      if (!targetMode) return;
      var v = self.viewers.get(self.activeViewerType);
      if (v && typeof v.setMode === 'function') {
        v.setMode(targetMode);
        self.updateModeToggle();
      }
    });
    pane.appendChild(modeBtn);
    this.modeBtn = modeBtn;

    // V3.x.1: chrome buttons container. Anchor for per-viewer
    // buttons declared via getChromeButtons(). Position is set
    // per-button at render time so the count + the mode-toggle
    // visibility together determine the stack offset. See spec
    // §4.1.A / §4.1.C.
    var chromeEl = document.createElement('div');
    chromeEl.className = 'files-chrome-buttons';
    pane.appendChild(chromeEl);
    this.chromeButtonsEl = chromeEl;
    /** Map<id, { el: HTMLButtonElement, desc: ChromeButton }>.
     *  Reconciled by updateChromeButtons. */
    this._chromeButtonsState = new Map();

    // V2.d: per-tab error surface (chrome-button failures, etc.).
    // Hidden until populated; auto-cleared on next successful
    // chrome-button action or mode change.
    var errEl = document.createElement('div');
    errEl.className = 'files-tab-error';
    errEl.hidden = true;
    pane.appendChild(errEl);
    this.errEl = errEl;
  }

  // type getter (compat for buildPersistBody / jumpToMostRecent which
  // filter `t.type === 'diff'`). Returns the default viewer type so a
  // markdown-default tab toggled to diff still persists as markdown-
  // default (correct: cards schema represents which file you opened,
  // not which viewer you're currently looking at).
  Object.defineProperty(TabContainer.prototype, 'type', {
    get: function() { return this.defaultViewerType; },
  });

  // For diff-default tabs, expose the diff viewer's `edit` so V1's
  // jumpToMostRecent / dismissed-snapshot logic that reads `tab.edit`
  // continues to work. For markdown-default tabs whose diff viewer
  // isn't constructed, returns null.
  Object.defineProperty(TabContainer.prototype, 'edit', {
    get: function() {
      var d = this.viewers.get('diff');
      return d ? d.edit : null;
    },
  });

  TabContainer.prototype.activate = function() {
    this.contentEl.style.display = '';
    var v = this.viewers.get(this.activeViewerType);
    if (v) v.activate();
  };

  TabContainer.prototype.deactivate = function() {
    var v = this.viewers.get(this.activeViewerType);
    if (v) v.deactivate();
    this.contentEl.style.display = 'none';
  };

  TabContainer.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    var self = this;
    // V3.x.2: cancel all pending eviction timers before tearing
    // down viewers (eviction would no-op on a destroyed container
    // but explicit clear keeps the timer table tidy).
    if (this._evictionTimers) {
      this._evictionTimers.forEach(function(id) { clearTimeout(id); });
      this._evictionTimers.clear();
    }
    this.viewers.forEach(function(v) {
      try { v.destroy(); } catch (err) { console.warn('[files-applet] viewer destroy:', err); }
    });
    this.viewers.clear();
    if (this.tabEl && this.tabEl.parentNode) this.tabEl.parentNode.removeChild(this.tabEl);
    if (this.contentEl && this.contentEl.parentNode) this.contentEl.parentNode.removeChild(this.contentEl);
    this.toggleBtn = null;
    this.tabEl = null;
    this.contentEl = null;
  };

  TabContainer.prototype.echoState = function() {
    var v = this.viewers.get(this.activeViewerType);
    var frag = (v && typeof v.echoState === 'function') ? v.echoState() : {};
    var out = {
      id: this.id,
      label: this.label,
      activeViewer: this.activeViewerType,
      defaultViewer: this.defaultViewerType,
      activeMode: (v && typeof v.getActiveMode === 'function') ? v.getActiveMode() : null,
      isDirty: !!(v && typeof v.isDirty === 'function' && v.isDirty()),
    };
    for (var k in frag) {
      if (Object.prototype.hasOwnProperty.call(frag, k)) out[k] = frag[k];
    }
    return out;
  };

  /** Update the floating toggle's visibility and label. Called at
   *  construction (post-mount) and after every switchViewer. */
  TabContainer.prototype.updateToggle = function() {
    if (!this.toggleBtn) return;
    var available = [];
    for (var i = 0; i < this.shell.viewers.length; i++) {
      var d = this.shell.viewers[i];
      if (d.canHandle(this.absPath, this.relPath)) available.push(d);
    }
    if (available.length < 2) { this.toggleBtn.hidden = true; return; }
    this.toggleBtn.hidden = false;
    var self = this;
    var other = null;
    for (var j = 0; j < available.length; j++) {
      if (available[j].viewerType !== self.activeViewerType) { other = available[j]; break; }
    }
    if (!other) { this.toggleBtn.hidden = true; return; }
    this.toggleBtn.textContent = '→ ' + other.label;
    this.toggleBtn.dataset.target = other.viewerType;
  };

  /** V2.d: update the mode toggle button based on the active
   *  viewer's getModes(). Hides if the viewer has no modes or
   *  fewer than 2. Adds/removes a `has-modes` class on contentEl
   *  so CSS can reserve the save-button slot. */
  TabContainer.prototype.updateModeToggle = function() {
    if (!this.modeBtn || !this.contentEl) return;
    var v = this.viewers.get(this.activeViewerType);
    var modes = (v && typeof v.getModes === 'function') ? v.getModes() : null;
    if (!modes || modes.length < 2) {
      this.modeBtn.hidden = true;
      this.contentEl.classList.remove('has-modes');
      this.updateChromeButtons();
      return;
    }
    this.contentEl.classList.add('has-modes');
    this.modeBtn.hidden = false;
    var active = (typeof v.getActiveMode === 'function') ? v.getActiveMode() : null;
    var other = null;
    for (var i = 0; i < modes.length; i++) {
      if (modes[i].id !== active) { other = modes[i]; break; }
    }
    if (!other) {
      this.modeBtn.hidden = true;
      this.contentEl.classList.remove('has-modes');
      this.updateChromeButtons();
      return;
    }
    this.modeBtn.textContent = '→ ' + other.label;
    this.modeBtn.dataset.target = other.id;
    // Tail-call (spec §4.1.A): chrome buttons read post-update
    // mode-toggle state when computing their base offset.
    this.updateChromeButtons();
  };

  /** V3.x.1: reconcile chrome buttons against active viewer's
   *  getChromeButtons(). See spec §4.1.B.
   *  - Stable id identifies each button across calls.
   *  - visible/disabled predicates re-evaluated each tick.
   *  - Position computed per visible button: base offset
   *    depends on mode-toggle visibility (40 vs 72), each
   *    visible button advances by 40px (32 button + 8 gap). */
  TabContainer.prototype.updateChromeButtons = function() {
    if (!this.chromeButtonsEl || !this.contentEl) return;
    var v = this.viewers.get(this.activeViewerType);
    var desired = (v && typeof v.getChromeButtons === 'function') ? v.getChromeButtons() : [];
    if (!Array.isArray(desired)) desired = [];

    var self = this;
    var seen = new Set();
    var dups = new Set();

    desired.forEach(function(desc) {
      if (!desc || !desc.id) return;
      if (seen.has(desc.id)) {
        if (!dups.has(desc.id)) {
          console.warn('[files-applet] duplicate chrome-button id:', desc.id);
          dups.add(desc.id);
        }
        return;
      }
      seen.add(desc.id);

      var entry = self._chromeButtonsState.get(desc.id);
      var btn;
      if (entry) {
        btn = entry.el;
        entry.desc = desc;
      } else {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var current = self._chromeButtonsState.get(desc.id);
          if (!current) return;
          var d = current.desc;
          var label = d.label;
          btn.disabled = true;
          Promise.resolve().then(function() { return d.onClick(); })
            .then(function() {
              self._clearChromeError();
            }, function(err) {
              var msg = (err && err.message) ? err.message : String(err);
              self._showChromeError(label + ': ' + msg);
            })
            .then(function() {
              var cur2 = self._chromeButtonsState.get(desc.id);
              var d2 = cur2 ? cur2.desc : d;
              if (typeof d2.disabled === 'function') btn.disabled = !!d2.disabled();
              else btn.disabled = false;
            });
        });
        self.chromeButtonsEl.appendChild(btn);
        entry = { el: btn, desc: desc };
        self._chromeButtonsState.set(desc.id, entry);
      }
      // Update mutable visual state.
      var cls = 'files-chrome-btn';
      if (desc.className) cls += ' ' + desc.className;
      btn.className = cls;
      btn.textContent = desc.label;
      if (desc.title) btn.title = desc.title; else btn.removeAttribute('title');
      var visible = (typeof desc.visible === 'function') ? !!desc.visible() : true;
      btn.hidden = !visible;
      // Update disabled state from the predicate. Viewers MUST keep
      // their disabled predicate accurate during async operations
      // (e.g. MarkdownViewer flips _saveInFlight true before the
      // first await, so updateChromeButtons during the await sees
      // disabled=true). The click handler also re-applies after
      // its Promise settles for the case where there is no
      // accurate predicate.
      if (typeof desc.disabled === 'function') btn.disabled = !!desc.disabled();
    });

    // Remove orphan state entries (buttons gone from desired).
    var toRemove = [];
    self._chromeButtonsState.forEach(function(entry, id) {
      if (!seen.has(id)) toRemove.push(id);
    });
    toRemove.forEach(function(id) {
      var entry = self._chromeButtonsState.get(id);
      if (entry && entry.el && entry.el.parentNode) {
        entry.el.parentNode.removeChild(entry.el);
      }
      self._chromeButtonsState.delete(id);
    });

    // Compute base offset from current mode-toggle visibility
    // (spec §4.1.A trigger ordering: tail-call from updateModeToggle
    // means modeBtn.hidden reflects the new state).
    var base = (this.modeBtn && !this.modeBtn.hidden) ? 72 : 40;
    var idx = 0;
    // Layout VISIBLE buttons in desired order.
    desired.forEach(function(desc) {
      if (!desc || !desc.id) return;
      var entry = self._chromeButtonsState.get(desc.id);
      if (!entry || entry.el.hidden) return;
      entry.el.style.top = (base + idx * 40) + 'px';
      idx += 1;
    });

    // Keep the is-dirty class on contentEl for back-compat with
    // existing CSS (V2.d). It tracks the active viewer's isDirty.
    var dirty = !!(v && typeof v.isDirty === 'function' && v.isDirty());
    this.contentEl.classList.toggle('is-dirty', dirty);
  };

  TabContainer.prototype._showChromeError = function(msg) {
    if (!this.errEl) return;
    this.errEl.textContent = msg;
    this.errEl.hidden = false;
  };
  TabContainer.prototype._clearChromeError = function() {
    if (!this.errEl) return;
    this.errEl.hidden = true;
    this.errEl.textContent = '';
  };

  /** V3.x.2: schedule eviction for an inactive viewer.
   *  No-op when shell config is null/disabled. The next
   *  switchViewer is the only arming entrypoint (spec §4.2.A). */
  TabContainer.prototype._scheduleEviction = function(viewerType) {
    if (this.destroyed) return;
    var ms = this.shell.getEvictionTimeoutMs && this.shell.getEvictionTimeoutMs();
    if (!ms) return;
    this._cancelEviction(viewerType);
    var self = this;
    var id = setTimeout(function() { self._evictViewer(viewerType); }, ms);
    this._evictionTimers.set(viewerType, id);
  };

  TabContainer.prototype._cancelEviction = function(viewerType) {
    var id = this._evictionTimers.get(viewerType);
    if (id != null) clearTimeout(id);
    this._evictionTimers.delete(viewerType);
  };

  TabContainer.prototype._evictViewer = function(viewerType) {
    if (this.destroyed) return;
    if (viewerType === this.activeViewerType) return;
    if (!this.viewers.has(viewerType)) return;
    var v = this.viewers.get(viewerType);
    if (v && typeof v.isDirty === 'function' && v.isDirty()) {
      // Dirty veto (spec §4.2.A policy A): do NOT evict, do NOT
      // re-arm. The next switchViewer re-arms naturally.
      return;
    }
    try { v.destroy(); } catch (e) { console.warn('[files-applet] eviction destroy:', e); }
    this.viewers.delete(viewerType);
    this._evictionTimers.delete(viewerType);
    this.shell.echoState();
  };

  /** Switch to a different viewer type. Lazy-constructs the viewer
   *  on first switch. See spec §4.0.5 rules 9-10 + spec §4.0.C
   *  + V2 spec §4.0.B (isDirty prompt). */
  TabContainer.prototype.switchViewer = async function(viewerType) {
    if (this.destroyed) return;
    if (viewerType === this.activeViewerType) return;
    if (this.switching) return;
    var desc = null;
    for (var i = 0; i < this.shell.viewers.length; i++) {
      if (this.shell.viewers[i].viewerType === viewerType) { desc = this.shell.viewers[i]; break; }
    }
    if (!desc) { console.warn('[files-applet] unknown viewer type', viewerType); return; }
    // Invariant: never switch to a viewer that cannot handle this
    // file. Without this guard a binary tab can be force-switched
    // to the diff viewer (e.g. by stale applyAgentState replay
    // after SOURCE_ID regeneration) and render junk.
    if (!desc.canHandle(this.absPath, this.relPath)) {
      console.warn('[files-applet] refusing to switch', this.relPath,
        '→', viewerType, '(viewer cannot handle this file)');
      return;
    }

    // V2.d: isDirty prompt on OUTGOING viewer. If user cancels,
    // abort the switch.
    var outgoing = this.viewers.get(this.activeViewerType);
    if (outgoing && typeof outgoing.isDirty === 'function' && outgoing.isDirty()) {
      if (!window.confirm('Discard unsaved changes?')) return;
    }

    this.switching = true;
    if (this.toggleBtn) this.toggleBtn.disabled = true;
    var priorType = this.activeViewerType;
    var prior = this.viewers.get(priorType);

    try {
      if (prior) prior.deactivate();
      if (!this.viewers.has(viewerType)) {
        var v = await desc.open(this.shell, this, this.absPath, this.relPath);
        if (this.destroyed) {
          try { v.destroy(); } catch (_e) { /* ignore */ }
          return;
        }
        this.viewers.set(viewerType, v);
      }
      this.viewers.get(viewerType).activate();
      this.activeViewerType = viewerType;
      // V3.x.2 eviction arming: the incoming viewer is now active
      // (cancel any pending eviction for it); the outgoing viewer
      // becomes a candidate (schedule eviction). switchViewer is
      // the only arming entrypoint (spec §4.2.A).
      this._cancelEviction(viewerType);
      if (prior && priorType !== viewerType) {
        this._scheduleEviction(priorType);
      }
      this.updateToggle();
      this.updateModeToggle();
      this.shell.echoState();
    } catch (err) {
      console.warn('[files-applet] switchViewer failed:', err);
      // Recovery: re-activate prior viewer if still around AND
      // restore activeViewerType so the §4.0.H invariant holds.
      // Without the assignment, container.activate()'s
      // viewers.get(activeViewerType) would return undefined.
      if (prior && !prior.destroyed) {
        this.activeViewerType = priorType;
        try { prior.activate(); } catch (_e) { /* ignore */ }
      }
    } finally {
      this.switching = false;
      if (this.toggleBtn) this.toggleBtn.disabled = false;
    }
  };

  /** Set the diff viewer's pendingSelection (used by applyAgentState)
   *  — ensures the viewer is constructed first. Returns a Promise that
   *  resolves with the diff viewer. */
  TabContainer.prototype.ensureDiffViewer = async function() {
    if (this.viewers.has('diff')) return this.viewers.get('diff');
    await this.switchViewer('diff');
    return this.viewers.get('diff') || null;
  };

  // ── V3.5: Selection state + agent / user exchange ────────────────────
  //
  // V3.5 model: native browser text selection is the input gesture.
  // tab.selection is the persistent line envelope (truth for the
  // agent and the .fe-row-selected paint). When the pane loses
  // focus, the browser drops the native Range; the paint persists.
  // No attempt is made to restore the native Range on focus-in
  // (spec §B1: defeated by mousedown→focus→mouseup ordering).

  /** Random per-page-load ID. Included in applet→agent echoes so
   *  cross-tab loops are prevented: Tab A's echo reaches Tab B via
   *  broadcast, but Tab B sees Tab A's sourceId and bails. Agent
   *  pushes have no sourceId (the server tool omits it), so every tab
   *  applies them; each tab's resulting echo carries its own sourceId
   *  which other tabs filter. Single-tab loops can't occur because
   *  appletAPI.setAppletState sends via WebSocket and the server's
   *  broadcastToAll excludes the sender connection. */
  var SOURCE_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'src-' + Math.random().toString(36).slice(2) + '-' + Date.now();

  /** Build the broadcast shape for the agent. Always reflects the
   *  currently-active tab + its selection envelope. Includes the
   *  user-selected text (truncated to TEXT_CAP) when the selection
   *  was set by a user gesture (drag or gutter click). Agent-pushed
   *  selections have no captured text. */
  function buildFileEditsLegacyState() {
    var container = activeTabId ? tabs.get(activeTabId) : null;
    var diff = activeDiffViewer(container);
    if (!diff || !diff.selection) {
      return { activeTab: activeTabId, selection: null, sourceId: SOURCE_ID };
    }
    var s = { start: diff.selection.start, end: diff.selection.end };
    if (typeof diff.selection.text === 'string') s.text = diff.selection.text;
    return { activeTab: activeTabId, selection: s, sourceId: SOURCE_ID };
  }

  /** Per-tab fragment for the V1.1 `files` envelope. The container's
   *  echoState already composes its own active-viewer fragment. */
  function buildFilesState() {
    var arr = [];
    tabs.forEach(function(t) {
      var frag = (typeof t.echoState === 'function') ? t.echoState() : null;
      if (frag == null) return;
      arr.push(frag);
    });
    return { tabs: arr, activeTabId: activeTabId };
  }

  // Coalesced echo via queueMicrotask:
  var echoPending = false;
  function echoState() {
    if (echoPending) return;
    if (!window.appletAPI || !window.appletAPI.setAppletState) return;
    echoPending = true;
    var schedule = (typeof queueMicrotask === 'function')
      ? queueMicrotask
      : function(fn) { Promise.resolve().then(fn); };
    schedule(function() {
      echoPending = false;
      // V2.d: refresh the active container's save-button visibility
      // before pushing state, so the button visibility tracks
      // isDirty changes (textarea input fires echoState).
      var active = activeTabId ? tabs.get(activeTabId) : null;
      if (active && typeof active.updateChromeButtons === 'function') {
        active.updateChromeButtons();
      }
      if (active && typeof active.updateModeToggle === 'function') {
        active.updateModeToggle();
      }
      try {
        window.appletAPI.setAppletState({
          fileEdits: buildFileEditsLegacyState(),
          files: buildFilesState(),
        });
      } catch (err) {
        console.warn('[file-edits] setAppletState failed:', err);
      }
    });
  }

  /** Highest working-tree line number for the tab. Used as the
   *  bounds-check ceiling in validateSelection. */
  function workLinesOf(tab) {
    if (!tab || !tab.edit || !tab.edit.fullFile) return null;
    var ff = tab.edit.fullFile;
    if (!Array.isArray(ff.workLines)) return null;
    return ff.workLines.length;
  }

  /** Validate + normalize + clamp an incoming selection per V3.4 §Data
   *  model rules. Returns null if invalid (drop). `validWorkLines`
   *  excludes pure-deletion lines; start clamps UP and end clamps DOWN
   *  to the nearest member. */
  function validateSelection(sel, maxLine, validWorkLines) {
    if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number') return null;
    var a = sel.start, b = sel.end;
    if (maxLine != null) {
      if (a < 1 || a > maxLine || b < 1 || b > maxLine) return null;
    }
    if (a > b) { var t = a; a = b; b = t; }
    if (validWorkLines) {
      var sortedAsc = Array.from(validWorkLines).sort(function(x, y) { return x - y; });
      var newStart = null, newEnd = null;
      for (var i = 0; i < sortedAsc.length; i++) {
        if (sortedAsc[i] >= a) { newStart = sortedAsc[i]; break; }
      }
      for (var j = sortedAsc.length - 1; j >= 0; j--) {
        if (sortedAsc[j] <= b) { newEnd = sortedAsc[j]; break; }
      }
      if (newStart == null || newEnd == null || newStart > newEnd) return null;
      a = newStart; b = newEnd;
    }
    return { start: a, end: b };
  }

  /** Set of work-line numbers actually rendered in a tab's pane. */
  function renderedWorkLines(tab) {
    if (!tab || !tab.paneEl) return null;
    var rows = tab.paneEl.querySelectorAll('.fe-row[data-work-line]');
    var s = new Set();
    for (var i = 0; i < rows.length; i++) {
      s.add(parseInt(rows[i].dataset.workLine, 10));
    }
    return s;
  }

  /** Scroll the diff viewer's contentEl so the selection's first line
   *  is at ~30% from the viewport top. `tab` here is a DiffViewer
   *  (V1.1: per-viewer scroll containers, see spec §4.0.E). */
  function scrollPaneToLine(tab, line) {
    if (!tab || !tab.paneEl) return;
    var row = tab.paneEl.querySelector('.fe-row[data-work-line="' + line + '"]');
    if (!row) return;
    var scrollEl = tab.contentEl;
    var rowRect = row.getBoundingClientRect();
    var paneRect = scrollEl.getBoundingClientRect();
    var offset = rowRect.top - paneRect.top + scrollEl.scrollTop;
    var target = Math.max(0, offset - scrollEl.clientHeight * 0.3);
    tab.scrollTop = target;
    programmaticScrollTo(scrollEl, target);
  }

  // ── Native-selection ↔ envelope translation ─────────────────────────
  //
  // Endpoint snap rules (spec §1 step 3):
  //   - In a .fe-row[data-work-line]: use that row's line.
  //   - In a row without data-work-line (pure-del) or in the pane
  //     background: snap to nearest rendered work-line — start
  //     endpoint goes DOWN, end endpoint goes UP. (Same direction
  //     covers "outside the pane subtree entirely": an endpoint
  //     above the pane in DOM order snaps DOWN to the first
  //     work-line; below snaps UP to the last.)

  function endpointToElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function lineOfRow(row) {
    var n = parseInt(row.dataset.workLine, 10);
    return isNaN(n) ? null : n;
  }

  /** Walk workRows (DOM order) for the first row at or after the
   *  reference element by document position. Returns its work-line,
   *  or null if no row qualifies. */
  function snapStartByDomPos(ref, workRows) {
    if (!ref || workRows.length === 0) return null;
    for (var i = 0; i < workRows.length; i++) {
      var row = workRows[i];
      if (row === ref || row.contains(ref)) return lineOfRow(row);
      var pos = ref.compareDocumentPosition(row);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return lineOfRow(row);
    }
    return null;
  }

  /** Walk workRows (reverse DOM order) for the last row at or before
   *  the reference element by document position. */
  function snapEndByDomPos(ref, workRows) {
    if (!ref || workRows.length === 0) return null;
    for (var i = workRows.length - 1; i >= 0; i--) {
      var row = workRows[i];
      if (row === ref || row.contains(ref)) return lineOfRow(row);
      var pos = ref.compareDocumentPosition(row);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return lineOfRow(row);
    }
    return null;
  }

  /** Convert a non-collapsed DOM Range to a line envelope by snapping
   *  each endpoint. Returns null if the resulting envelope is
   *  invalid (no overlap with any rendered work-line). */
  function envelopeFromRange(range, paneSubtree) {
    if (!range || range.collapsed) return null;
    var workRows = paneSubtree.querySelectorAll('.fe-row[data-work-line]');
    if (workRows.length === 0) return null;

    function snap(node, isStart) {
      var el = endpointToElement(node);
      if (el && paneSubtree.contains(el)) {
        var row = el.closest('.fe-row[data-work-line]');
        if (row && paneSubtree.contains(row)) return lineOfRow(row);
      }
      return isStart ? snapStartByDomPos(el || node, workRows)
                     : snapEndByDomPos(el || node, workRows);
    }

    var startLine = snap(range.startContainer, true);
    var endLine = snap(range.endContainer, false);
    if (startLine == null || endLine == null) return null;
    if (startLine > endLine) return null;
    return { start: startLine, end: endLine };
  }

  /** Build a DOM Range spanning the .fe-line content of rows
   *  [envelope.start..envelope.end] in the given tab. Returns null
   *  if either bounding row is missing. */
  function rangeFromEnvelope(tab, envelope) {
    if (!tab || !tab.paneEl || !envelope) return null;
    var startRow = tab.paneEl.querySelector('.fe-row[data-work-line="' + envelope.start + '"]');
    var endRow = tab.paneEl.querySelector('.fe-row[data-work-line="' + envelope.end + '"]');
    if (!startRow || !endRow) return null;
    var startLine = startRow.querySelector('.fe-line');
    var endLine = endRow.querySelector('.fe-line');
    if (!startLine || !endLine) return null;
    var range = document.createRange();
    try {
      range.setStart(startLine, 0);
      range.setEnd(endLine, endLine.childNodes.length);
    } catch (err) {
      return null;
    }
    return range;
  }

  // ── Echo-loop guard for programmatic addRange ───────────────────────
  //
  // Before any programmatic addRange we install an _expectedEnvelope
  // token. The selectionchange handler consumes the token when it
  // observes a matching envelope and skips the echo for that one
  // event. Value-comparison, not a timing flag — selectionchange
  // dispatches asynchronously and a microtask-clear would race the
  // dispatch (same lesson as pendingProgrammaticScroll).

  var _expectedEnvelope = null;
  var _expectedEnvelopeTimer = 0;

  function setExpectedEnvelope(env) {
    if (_expectedEnvelopeTimer) clearTimeout(_expectedEnvelopeTimer);
    _expectedEnvelope = env ? { start: env.start, end: env.end } : null;
    _expectedEnvelopeTimer = setTimeout(function() {
      _expectedEnvelope = null;
      _expectedEnvelopeTimer = 0;
    }, 250);
  }

  function consumeExpectedEnvelope(observed) {
    if (!_expectedEnvelope || !observed) return false;
    if (_expectedEnvelope.start !== observed.start) return false;
    if (_expectedEnvelope.end !== observed.end) return false;
    _expectedEnvelope = null;
    if (_expectedEnvelopeTimer) clearTimeout(_expectedEnvelopeTimer);
    _expectedEnvelopeTimer = 0;
    return true;
  }

  /** Apply an envelope to the native Selection. Sets the expected-
   *  envelope token first so the resulting selectionchange is
   *  recognized as a programmatic restore and doesn't echo. Returns
   *  true if the Range was built and applied. */
  function applyEnvelopeAsRange(tab, envelope) {
    var range = rangeFromEnvelope(tab, envelope);
    if (!range) return false;
    var sel = window.getSelection && window.getSelection();
    if (!sel) return false;
    setExpectedEnvelope(envelope);
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {
      return false;
    }
    return true;
  }

  // ── User-drag tracking ──────────────────────────────────────────────
  //
  // _userDragging is true between mousedown (on diff content) and
  // mouseup (anywhere). During the drag, selection-change echoes are
  // deferred until mouseup to avoid flooding the WebSocket. Scoped
  // to .fe-line / .fe-row mousedowns so scrollbar drags don't
  // suppress agent addRange (spec §I-v2-4).

  var _userDragging = false;
  var _pendingDragEcho = false;

  paneEl.addEventListener('mousedown', function(e) {
    if (!e.target || !e.target.closest) return;
    // Scope to .fe-line only: drag-to-select-text inside diff content.
    // Excludes fold/collapse buttons (in .fe-row but not .fe-line) so
    // clicking them doesn't suppress agent addRange via _userDragging.
    // Excludes gutter clicks (the gutter is a separate gesture handled
    // by the click handler below).
    var inDiffContent = e.target.closest('.fe-line');
    if (inDiffContent && paneEl.contains(inDiffContent)) {
      _userDragging = true;
    }
  });

  function endUserDrag() {
    if (!_userDragging) return;
    _userDragging = false;
    if (_pendingDragEcho) {
      _pendingDragEcho = false;
      echoState();
    }
  }

  document.addEventListener('mouseup', endUserDrag, true);
  window.addEventListener('blur', endUserDrag, true);

  // ── selectionchange handler (drag → envelope → state) ───────────────

  var _selectionChangeRafScheduled = false;

  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    var intersects = false;
    try { intersects = range.intersectsNode(paneEl); } catch (err) { return; }
    if (!intersects) return;  // sync bail before rAF schedule
    if (_selectionChangeRafScheduled) return;
    _selectionChangeRafScheduled = true;
    requestAnimationFrame(function() {
      _selectionChangeRafScheduled = false;
      handleSelectionChange();
    });
  });

  // ── Selection text capture ──────────────────────────────────────────
  //
  // The line envelope tells the agent WHICH lines the user cares
  // about; the captured text tells it EXACTLY what they highlighted
  // (sub-word precision). Captured at gesture time because the
  // browser's native Range is lost on focus-out — by the time the
  // agent reads it via get_applet_state, range.toString() is empty.

  var TEXT_CAP = 4096;

  function capText(s) {
    if (typeof s !== 'string') return '';
    if (s.length <= TEXT_CAP) return s;
    return s.slice(0, TEXT_CAP) + '\u2026';
  }

  /** Text of the user's actual Range. Trimmed to TEXT_CAP. */
  function textFromRange(range) {
    if (!range) return '';
    try { return capText(range.toString()); } catch (err) { return ''; }
  }

  /** Concatenated .fe-line textContent for the gutter-click case
   *  where there's no native Range yet (we're about to install one).
   *  Joins rows [start..end] with \n. */
  function textFromEnvelope(tab, envelope) {
    if (!tab || !tab.paneEl || !envelope) return '';
    var parts = [];
    for (var line = envelope.start; line <= envelope.end; line++) {
      var row = tab.paneEl.querySelector('.fe-row[data-work-line="' + line + '"]');
      if (!row) continue;
      var lineEl = row.querySelector('.fe-line');
      if (lineEl) parts.push(lineEl.textContent || '');
    }
    return capText(parts.join('\n'));
  }

  function handleSelectionChange() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed) return;  // caret placement; do NOT clear tab.selection (spec §1 step 2)
    try { if (!range.intersectsNode(paneEl)) return; } catch (err) { return; }
    var container = activeTabId ? tabs.get(activeTabId) : null;
    var tab = activeDiffViewer(container);
    if (!tab || !tab.paneEl || tab.paneEl.parentNode !== container.contentEl) return;

    var raw = envelopeFromRange(range, tab.paneEl);
    if (!raw) return;
    var envelope = validateSelection(raw, workLinesOf(tab), renderedWorkLines(tab));
    if (!envelope) return;

    var text = textFromRange(range);

    if (consumeExpectedEnvelope(envelope)) {
      // Programmatic restore (gutter click or agent push). The
      // envelope itself was already echoed; capture the text now
      // (the browser has just installed the Range, so toString()
      // works) and update tab.selection without re-echoing the
      // envelope-only payload. If text changed, echo to ship it.
      if (tab.selection && tab.selection.text !== text) {
        tab.selection = { start: envelope.start, end: envelope.end, text: text };
        if (_userDragging) _pendingDragEcho = true;
        else echoState();
      }
      return;
    }

    var wasNull = !tab.selection;
    var changed = wasNull
      || tab.selection.start !== envelope.start
      || tab.selection.end !== envelope.end
      || tab.selection.text !== text;
    if (!changed) return;

    tab.selection = { start: envelope.start, end: envelope.end, text: text };
    tab.paintSelection();

    if (wasNull && followEdits) {
      followEdits = false;
      updateFollowButton();
    }

    if (_userDragging) _pendingDragEcho = true;
    else echoState();
  }

  // ── Click handlers: gutter (select line), background (clear) ────────

  paneEl.addEventListener('mousedown', function(e) {
    if (!e.shiftKey) return;
    var gutter = e.target.closest && e.target.closest('.fe-row[data-work-line] > .fe-gutter');
    if (gutter) e.preventDefault();
  });

  paneEl.addEventListener('click', function(e) {
    if (!e.target || !e.target.closest) return;
    var gutter = e.target.closest('.fe-row[data-work-line] > .fe-gutter');
    if (gutter) {
      e.preventDefault();
      var row = gutter.closest('.fe-row[data-work-line]');
      var line = lineOfRow(row);
      if (line == null) return;
      var container = activeTabId ? tabs.get(activeTabId) : null;
      var tab = activeDiffViewer(container);
      if (!tab) return;
      var raw;
      if (e.shiftKey && tab.selection) {
        raw = { start: tab.selection.start, end: line };
      } else {
        raw = { start: line, end: line };
      }
      var envelope = validateSelection(raw, workLinesOf(tab), renderedWorkLines(tab));
      if (!envelope) return;
      var wasNull = !tab.selection;
      tab.selection = {
        start: envelope.start,
        end: envelope.end,
        text: textFromEnvelope(tab, envelope),
      };
      tab.paintSelection();
      if (wasNull && followEdits) {
        followEdits = false;
        updateFollowButton();
      }
      applyEnvelopeAsRange(tab, envelope);
      echoState();
      return;
    }
    // Click landed on .fe-diff content area but not on any .fe-row
    // (i.e. trailing whitespace below the last line). Clear.
    var diffEl = e.target.closest('.fe-diff');
    var anyRow = e.target.closest('.fe-row');
    if (diffEl && !anyRow) {
      var container2 = activeTabId ? tabs.get(activeTabId) : null;
      var tab2 = activeDiffViewer(container2);
      if (tab2 && tab2.selection) {
        tab2.selection = null;
        tab2.paintSelection();
        var sel = window.getSelection && window.getSelection();
        if (sel) sel.removeAllRanges();
        echoState();
      }
    }
  });

  // ── Escape clears selection ──────────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (pickerOpen) return;  // picker handles Escape itself
    var container = activeTabId ? tabs.get(activeTabId) : null;
    var tab = activeDiffViewer(container);
    if (tab && tab.selection) {
      e.preventDefault();
      tab.selection = null;
      tab.paintSelection();
      var sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
      echoState();
    }
  });

  /** IDs that have a /file-edits/open fetch in-flight from
   *  applyAgentState. Reserved so concurrent caco.edit handlers don't
   *  push us over TAB_CAP and orphan our pending open. */
  var pendingOpenIds = new Set();

  /** Schedule finalizeAgentSelection two rAFs from now, cancelling any
   *  previously-scheduled chain on this tab. Collapses rapid agent
   *  pushes into a single finalize that reads the latest
   *  pendingSelection. */
  function scheduleAgentFinalize(tab) {
    if (tab._agentRaf1) cancelAnimationFrame(tab._agentRaf1);
    if (tab._agentRaf2) cancelAnimationFrame(tab._agentRaf2);
    tab._agentRaf1 = requestAnimationFrame(function() {
      tab._agentRaf1 = 0;
      tab._agentRaf2 = requestAnimationFrame(function() {
        tab._agentRaf2 = 0;
        finalizeAgentSelection(tab);
      });
    });
  }

  /** Apply agent-pushed state. Opens the tab via POST /open if no
   *  container exists for the path. Validation against rendered DOM
   *  happens in finalizeAgentSelection two rAFs later. Per spec
   *  §4.3.2, the cases are:
   *  - Existing container with diff viewer: feed pendingSelection.
   *  - Existing container WITHOUT diff viewer (markdown-default, no
   *    toggle): switchViewer('diff') then feed selection.
   *  - No container: POST /open, then create diff-default container. */
  async function applyAgentState(fileEdits) {
    if (!fileEdits || typeof fileEdits !== 'object') return;
    if (fileEdits.sourceId === SOURCE_ID) return;
    var targetRelPath = fileEdits.activeTab;
    var rawSel = fileEdits.selection || null;
    if (!targetRelPath) return;
    // Legacy envelope uses relPath. Markdown-default tab ids would
    // not appear here (agent selection is diff-only by design), but
    // be defensive: strip 'markdown:' prefix if present.
    if (typeof targetRelPath === 'string' && targetRelPath.indexOf('markdown:') === 0) return;
    // Agent selection is text-only — only meaningful for files the
    // diff viewer can render. For binaries (images, etc) the diff
    // viewer is not applicable and any switch would render garbage.
    // Skip the whole flow rather than force a bad switchViewer call.
    var diffDescForCheck = null;
    for (var di = 0; di < viewerRegistry.length; di++) {
      if (viewerRegistry[di].viewerType === 'diff') { diffDescForCheck = viewerRegistry[di]; break; }
    }
    var absForCheck = absPathOf(targetRelPath);
    if (diffDescForCheck && !diffDescForCheck.canHandle(absForCheck, targetRelPath)) return;

    var existing = findContainerByRelPath(targetRelPath, { mode: 'unstaged' });
    if (existing) {
      var dv = existing.viewers.get('diff');
      if (!dv) {
        // Markdown-default container, no diff viewer yet: switch it in.
        await existing.switchViewer('diff');
        dv = existing.viewers.get('diff');
      }
      if (!dv) return;
      dv.pendingSelection = rawSel;
      if (activeTabId !== existing.id) setActiveTab(existing.id);
      scheduleAgentFinalize(dv);
      return;
    }
    if (!sessionId) return;
    if (pendingOpenIds.has(targetRelPath)) return;
    var openSessionId = sessionId;
    pendingOpenIds.add(targetRelPath);
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(openSessionId) + '/file-edits/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: targetRelPath }),
      });
      if (sessionId !== openSessionId) return;
      if (!res.ok) { console.warn('[files-applet] agent setState: open failed', res.status, targetRelPath); echoState(); return; }
      var data = await res.json();
      if (sessionId !== openSessionId) return;
      if (!data.edit) { echoState(); return; }
      var raceCheck = findContainerByRelPath(targetRelPath, { mode: 'unstaged' });
      if (raceCheck) {
        var rdv = raceCheck.viewers.get('diff');
        if (!rdv) { await raceCheck.switchViewer('diff'); rdv = raceCheck.viewers.get('diff'); }
        if (rdv) {
          rdv.pendingSelection = rawSel;
          if (activeTabId !== raceCheck.id) setActiveTab(raceCheck.id);
          scheduleAgentFinalize(rdv);
        }
        return;
      }
      // No container at all: create a diff-default one from the fetched edit.
      if (tabs.size >= TAB_CAP) evictOldestNonActive();
      var diffDesc = null;
      for (var i = 0; i < viewerRegistry.length; i++) {
        if (viewerRegistry[i].viewerType === 'diff') { diffDesc = viewerRegistry[i]; break; }
      }
      var abs = absPathOf(targetRelPath);
      var container = new TabContainer(shell, diffDesc, abs, targetRelPath);
      var newDiff = DiffViewer.fromEdit(shell, container, data.edit);
      newDiff.pendingSelection = rawSel;
      container.viewers.set('diff', newDiff);
      tabs.set(container.id, container);
      tabsEl.appendChild(container.tabEl);
      paneEl.appendChild(container.contentEl);
      container.updateToggle();
      setActiveTab(container.id);
      scheduleAgentFinalize(newDiff);
      schedulePersist();
    } catch (err) {
      console.warn('[files-applet] agent setState: open error', err, targetRelPath);
      echoState();
    } finally {
      pendingOpenIds.delete(targetRelPath);
    }
  }

  /** Validate the pending agent selection against rendered DOM, write
   *  to tab.selection, paint, scroll, and (if pane focused and user
   *  isn't mid-drag) apply as a native Range so copy works. Echo. */
  function finalizeAgentSelection(tab) {
    var raw = tab.pendingSelection;
    tab.pendingSelection = null;
    if (!raw) {
      tab.selection = null;
    } else {
      tab.selection = validateSelection(raw, workLinesOf(tab), renderedWorkLines(tab));
    }
    tab.paintSelection();
    if (tab.selection) {
      // Order matters: scroll FIRST so startLine is visible, THEN
      // addRange. With startLine already on-screen, the browser's
      // addRange autoscroll is a no-op and doesn't race the
      // pendingProgrammaticScroll guard set by scrollPaneToLine.
      scrollPaneToLine(tab, tab.selection.start);
      var paneFocused = document.activeElement === paneEl || paneEl.contains(document.activeElement);
      if (paneFocused && !_userDragging) {
        applyEnvelopeAsRange(tab, tab.selection);
      }
    }
    echoState();
  }

  // ── End V3.5 selection ───────────────────────────────────────────────

  // ── Tab orchestration ────────────────────────────────────────────────
  function setActiveTab(tabId) {
    // Note: setActiveTab does NOT modify followEdits. Callers that
    // represent user gestures (tab click, X-on-active, picker selection)
    // must set followEdits=false themselves before calling.
    var next = tabs.get(tabId);
    // Defensive: enforce the §4.0.6 single-visible-tab invariant on
    // EVERY call, including the early-return path. If any race or
    // missing-deactivate ever leaks display:'' onto a non-active tab,
    // this loop restores the invariant on the next switch.
    tabs.forEach(function(t) {
      if (t !== next && t.contentEl && t.contentEl.style.display !== 'none') {
        t.contentEl.style.display = 'none';
        if (t.tabEl) t.tabEl.classList.remove('active');
      }
    });
    if (tabId === activeTabId) {
      // Still ensure the active tab IS visible (in case it was wrongly
      // hidden) and finish.
      if (next && next.contentEl && next.contentEl.style.display === 'none') {
        next.activate();
      }
      updateFollowButton();
      schedulePersist();
      return;
    }
    var prev = activeTabId ? tabs.get(activeTabId) : null;
    if (prev && prev !== next) {
      prev.deactivate();
      prev.tabEl.classList.remove('active');
    }
    activeTabId = tabId;
    if (next) {
      next.tabEl.classList.add('active');
      next.activate();
      // V2.d: re-evaluate mode/save buttons for the new active viewer.
      if (typeof next.updateModeToggle === 'function') next.updateModeToggle();
      if (typeof next.updateChromeButtons === 'function') next.updateChromeButtons();
      try {
        next.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      } catch (_) { /* old browsers */ }
    }
    updateEmptyState();
    updateFollowButton();
    schedulePersist();
    echoState();
  }

  /** Remove the oldest non-active tab. Called by openOrUpdateTab when
   *  the cap is hit. No-op if no non-active tab exists. */
  function evictOldestNonActive() {
    var iter = tabs.keys();
    var step;
    while (!(step = iter.next()).done) {
      var id = step.value;
      if (id !== activeTabId) {
        var t = tabs.get(id);
        tabs.delete(id);              // §4.0.5.2: remove from map first
        badgeCounter.delete(id);
        if (lastEditedTabId === id) lastEditedTabId = null;
        if (t) {
          try { t.destroy(); } catch (err) { console.warn('[file-edits] evict destroy:', err); }
        }
        return;
      }
    }
  }

  function openOrUpdateTab(edit, options) {
    options = options || {};
    var relPath = edit.relativePath;
    if (!relPath) return;
    // V1.1: look up by relPath (not by `id`) so a markdown-default
    // tab for the same file is found and we don't create a duplicate
    // container. Resolves spec §4.3 B2 hazard.
    // V6: explicitly scope to unstaged so the poller's caco.edit
    // never updates a staged or range tab (those are snapshots).
    var container = findContainerByRelPath(relPath, { mode: 'unstaged' });
    // Dismissed-path filter: only meaningful when no container exists.
    if (!container && !options.forceFocus && dismissedPaths.has(relPath)) {
      var snap = dismissedSnapshots.get(relPath);
      var sameContent = snap
        && snap.diff === edit.diff
        && snap.status === edit.status
        && snap.isBinary === edit.isBinary;
      // No-snapshot case: markdown-default tab was closed without
      // ever opening its diff viewer. Always suppress until session
      // switch or status==='clean' (spec §4.7).
      var noSnapshot = !snap;
      if (sameContent || noSnapshot || edit.status === 'clean') {
        if (edit.status === 'clean') {
          dismissedPaths.delete(relPath);
          dismissedSnapshots.delete(relPath);
        }
        return;
      }
      dismissedPaths.delete(relPath);
      dismissedSnapshots.delete(relPath);
    }
    var isNew = false;
    var contentChanged = false;
    if (!container) {
      // V5 fix: routeOpen guards itself with pendingOpenIds and only
      // calls tabs.set() AFTER awaiting the viewer factory. If the
      // poll fires between routeOpen's begin and its tabs.set, we'd
      // create a second container here for the same relPath — leaving
      // an orphan tab in the strip. Skip; routeOpen will produce
      // (or already has produced) the tab. The next caco.edit will
      // find it via findContainerByRelPath and update normally.
      if (pendingOpenIds.has(relPath)) return;
      if (tabs.size >= TAB_CAP) evictOldestNonActive();
      var abs = absPathOf(relPath);
      var desc = defaultViewer(abs, relPath);
      if (!desc) {
        // No viewer applies (rare: a binary that no viewer handles).
        // Drop the edit silently — there's nothing useful to show.
        console.warn('[files-applet] caco.edit for path with no default viewer:', relPath);
        return;
      }
      container = new TabContainer(shell, desc, abs, relPath);
      if (desc.viewerType === 'diff') {
        // Synchronous fast path: poller already gave us the edit.
        var diffViewer = DiffViewer.fromEdit(shell, container, edit);
        container.viewers.set('diff', diffViewer);
        tabs.set(container.id, container);
        tabsEl.appendChild(container.tabEl);
        paneEl.appendChild(container.contentEl);
        container.updateToggle();
        isNew = true;
        contentChanged = true;
      } else {
        // Async factory path (image, html, markdown). The `edit`
        // payload is ignored — only the path matters. Mark
        // rehydrating so concurrent caco.edit / setActiveTab gets
        // a clean no-op on the not-yet-constructed viewer. See spec
        // §4.1 / §4.3.2.
        container.rehydrating = true;
        tabs.set(container.id, container);
        tabsEl.appendChild(container.tabEl);
        paneEl.appendChild(container.contentEl);
        container.updateToggle();
        lastEditedTabId = container.id;
        if (followEdits) setActiveTab(container.id);
        (function() {
          var factoryDesc = desc;
          var factoryContainer = container;
          desc.open(shell, container, abs, relPath).then(function(v) {
            if (factoryContainer.destroyed) {
              try { v.destroy(); } catch (_e) { /* ignore */ }
              return;
            }
            factoryContainer.viewers.set(factoryDesc.viewerType, v);
            factoryContainer.rehydrating = false;
            // If this tab is currently active (followEdits set it
            // earlier), call activate now so the viewer renders.
            if (activeTabId === factoryContainer.id) {
              try { v.activate(); } catch (_e) { /* ignore */ }
            }
            schedulePersist();
            shell.echoState();
          }, function(err) {
            console.warn('[files-applet] non-diff factory failed', relPath, err);
            tabs.delete(factoryContainer.id);
            factoryContainer.destroy();
          });
        })();
        updateEmptyState();
        schedulePersist();
        return;
      }
    } else {
      // Container exists. Update its DiffViewer if constructed; if
      // the container has no DiffViewer (e.g. markdown-default
      // without a toggle yet, or image-default), the viewer's own
      // watcher refreshes — no lazy diff construction.
      var dv = container.viewers.get('diff');
      if (dv) {
        contentChanged = dv.update(edit);
        if (!contentChanged && !options.forceFocus) return;
      } else {
        if (!options.forceFocus) return;
      }
    }
    if (contentChanged) lastEditedTabId = container.id;

    if (options.forceFocus) {
      var dv2 = container.viewers.get('diff');
      if (dv2) dv2.scrollTop = 0;
      setActiveTab(container.id);
    } else if (followEdits) {
      var dv3 = container.viewers.get('diff');
      if (isNew && dv3) dv3.scrollTop = 0;
      setActiveTab(container.id);
    } else {
      if (contentChanged) {
        badgeCounter.add(relPath);
        updateFollowButton();
      }
    }
    updateEmptyState();
    if (isNew) reconcileTabDom();
    schedulePersist();
  }

  function closeTab(id) {
    var container = tabs.get(id);
    if (!container) return;
    // V2.d: isDirty prompt. Check EVERY constructed viewer in the
    // container (not just active — a markdown viewer toggled-away-
    // from could still be dirty). One prompt covers all of them.
    var anyDirty = false;
    container.viewers.forEach(function(v) {
      if (v && typeof v.isDirty === 'function' && v.isDirty()) anyDirty = true;
    });
    if (anyDirty) {
      if (!window.confirm('Discard unsaved changes?')) return;
    }
    var wasActive = id === activeTabId;
    // Compute neighbour BEFORE deleting — need pre-removal insertion order.
    var newActive = null;
    if (wasActive) {
      var keys = Array.from(tabs.keys());
      var idx = keys.indexOf(id);
      if (idx > 0) newActive = keys[idx - 1];                  // left neighbour
      else if (idx < keys.length - 1) newActive = keys[idx + 1]; // right neighbour
    }
    // Rule §4.0.5.2: remove from map BEFORE destroy. Any in-flight
    // async callback that re-enters the shell will see no tab at
    // this id and bail.
    tabs.delete(id);
    badgeCounter.delete(container.relPath);
    if (lastEditedTabId === id) lastEditedTabId = null;
    // Record dismissal so the next poll-driven caco.edit (which
    // re-broadcasts every currently-dirty file) does NOT re-create
    // this tab. KEYED BY relPath (spec §4.7).
    //
    // - If a DiffViewer with an edit is constructed: snapshot it for
    //   content-aware suppression (a genuinely-new edit re-opens).
    // - Otherwise (markdown / image / html default with no diff
    //   constructed): path-only entry, always-suppress until clean
    //   or session-switch.
    var dvForSnap = container.viewers.get('diff');
    dismissedPaths.add(container.relPath);
    if (dvForSnap && dvForSnap.edit) {
      dismissedSnapshots.set(container.relPath, {
        diff: dvForSnap.edit.diff,
        status: dvForSnap.edit.status,
        isBinary: dvForSnap.edit.isBinary,
      });
    }
    // No-snapshot case: leave dismissedSnapshots untouched. spec §4.7.
    if (wasActive) {
      // Hide the closing container's contentEl BEFORE setActiveTab
      // (which would otherwise see prev=null and skip deactivate).
      // Keeps the §4.0.6 single-visible invariant across the close.
      try { container.deactivate(); } catch (_e) { /* ignore */ }
      if (container.tabEl) container.tabEl.classList.remove('active');
      activeTabId = null;
      if (newActive) {
        setActiveTab(newActive);
      }
    }
    container.destroy();
    followEdits = false;
    updateFollowButton();
    updateEmptyState();
    reconcileTabDom();
    schedulePersist();
    echoState();
  }

  /** Self-heal stale tab DOMs that are no longer in the tabs map.
   *  These should never exist (closeTab/destroy keep them in sync),
   *  but a routeOpen race or a buggy future code path could leak one.
   *  Removing them here keeps ghost tabs from accumulating. Called
   *  after every structural tab change. */
  function reconcileTabDom() {
    if (!tabsEl) return;
    var validIds = new Set();
    tabs.forEach(function(c) {
      if (c && c.tabEl) validIds.add(c.tabEl);
    });
    var children = Array.prototype.slice.call(tabsEl.children);
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (!validIds.has(el)) {
        console.warn('[files-applet] removing orphan tab DOM', el.dataset && el.dataset.path);
        try { el.parentNode.removeChild(el); } catch (_e) { /* ignore */ }
      }
    }
  }

  function jumpToMostRecent() {
    if (tabs.size === 0) return;
    // Diff-only: this jumps to a file with an unstaged change. Markdown
    // tabs and future non-diff types have no concept of "dirty" and
    // are skipped. See docs/files-applet-v1.md Step 8.1.
    var targetId = null;
    var primary = lastEditedTabId && tabs.get(lastEditedTabId);
    if (primary && primary.type === 'diff' && primary.edit && primary.edit.status !== 'clean') {
      targetId = lastEditedTabId;
    } else {
      var bestMtime = -1;
      tabs.forEach(function(t, id) {
        if (t.type !== 'diff') return;
        if (!t.edit || t.edit.status === 'clean') return;
        var m = (typeof t.edit.mtimeMs === 'number') ? t.edit.mtimeMs : -1;
        if (m > bestMtime) { bestMtime = m; targetId = id; }
      });
      if (!targetId) {
        var keys = Array.from(tabs.keys());
        for (var i = keys.length - 1; i >= 0; i--) {
          var t2 = tabs.get(keys[i]);
          if (t2 && t2.type === 'diff' && t2.edit && t2.edit.status !== 'clean') {
            targetId = keys[i];
            break;
          }
        }
      }
    }
    if (!targetId) return;
    setActiveTab(targetId);
    // After activate's rAF builds the pane, find the first add/del row
    // and center it. Two rAFs because activate already used the first
    // frame to swap content + restore scroll.
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        scrollPaneToFirstDiffRow(targetId);
      });
    });
  }

  /** Scroll the pane to center the first add/del row of the given tab.
   *  Falls back to scroll-to-top when there are no diff rows (e.g.
   *  a freshly picked clean file). */
  function scrollPaneToFirstDiffRow(targetId) {
    var container = tabs.get(targetId);
    var t = activeDiffViewer(container);
    if (!t || !t.paneEl) return;
    var scrollEl = t.contentEl;
    var diffRow = t.paneEl.querySelector('.fe-row-add, .fe-row-del');
    if (!diffRow) {
      t.scrollTop = 0;
      programmaticScrollTo(scrollEl, 0);
      return;
    }
    var rowRect = diffRow.getBoundingClientRect();
    var paneRect = scrollEl.getBoundingClientRect();
    var offsetWithinPane = rowRect.top - paneRect.top + scrollEl.scrollTop;
    var target = offsetWithinPane - scrollEl.clientHeight * 0.3;
    t.scrollTop = Math.max(0, target);
    programmaticScrollTo(scrollEl, t.scrollTop);
  }

  function updateFollowButton() {
    if (followEdits) {
      followBtn.hidden = true;
      return;
    }
    followBtn.hidden = false;
    var n = badgeCounter.size;
    followBtn.textContent = n > 0
      ? ('↓ Follow edits · ' + n)
      : '↓ Follow edits';
  }

  function updateEmptyState() {
    var hasTabs = tabs.size > 0;
    paneEmptyEl.hidden = hasTabs || !notGitEl.hidden;
    if (!hasTabs && activeTabId === null) {
      // empty pane: clear any leftover content but keep our message div
      if (paneEl.firstChild && paneEl.firstChild !== paneEmptyEl && paneEl.firstChild !== notGitEl) {
        paneEl.innerHTML = '';
        paneEl.appendChild(paneEmptyEl);
        paneEl.appendChild(notGitEl);
      }
    }
  }

  followBtn.addEventListener('click', function() {
    followEdits = true;
    badgeCounter.clear();
    jumpToMostRecent();
    updateFollowButton();
  });

  // V1.1: per-viewer scroll handlers (DiffViewer installs its own in
  // _installScrollHandler). The outer .fe-pane no longer scrolls.

  // ── Persistence (V2.1 mechanism; tab list reuse cards[]) ─────────────
  var PERSIST_DEBOUNCE_MS = 250;
  var persistTimer = null;
  var persistPendingSid = null;
  var persistPendingBody = null;

  function buildPersistBody() {
    var list = [];
    // V2.c: persist ALL containers (not just diff-default). Schema
    // version 2 carries defaultViewerType + activeViewerType so the
    // user's tabs (and viewer-mode) survive applet close+reopen.
    // The Map iteration order is insertion order so tab-strip order
    // is preserved across reload. See docs/files-applet-v2.md §4.3.
    // V6: additive diffMode on the same schema. Older readers
    // ignore unknown fields. V6.1 dropped diffRef.
    tabs.forEach(function(container) {
      var card = {
        relativePath: container.relPath,
        defaultViewerType: container.defaultViewerType,
        activeViewerType: container.activeViewerType,
      };
      if (container.diffMode && container.diffMode !== 'unstaged') {
        card.diffMode = container.diffMode;
      }
      list.push(card);
    });
    return { schemaVersion: 2, cards: list, dismissed: [] };
  }

  function schedulePersist() {
    if (!sessionId) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistPendingSid = sessionId;
    persistPendingBody = buildPersistBody();
    persistTimer = setTimeout(function() {
      var sid = persistPendingSid;
      var body = persistPendingBody;
      persistTimer = null;
      persistPendingSid = null;
      persistPendingBody = null;
      if (!sid || !body) return;
      void doPersistPut(sid, body);
    }, PERSIST_DEBOUNCE_MS);
  }

  function flushPersist() {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    var sid = persistPendingSid;
    var body = persistPendingBody;
    persistTimer = null;
    persistPendingSid = null;
    persistPendingBody = null;
    if (!sid || !body) return;
    void doPersistPut(sid, body);
  }

  async function doPersistPut(sid, body) {
    try {
      await fetch('/api/sessions/' + encodeURIComponent(sid) + '/file-edits/cards', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn('[file-edits] persist failed:', err);
    }
  }

  function flushPersistBeacon() {
    if (!sessionId) return;
    try {
      var body = buildPersistBody();
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      navigator.sendBeacon('/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/cards', blob);
    } catch (_) { /* best effort */ }
  }
  window.addEventListener('beforeunload', flushPersistBeacon);

  // V2.d: dirty guard. If any tab has a dirty viewer (unsaved
  // markdown editor content), trigger the browser's native
  // "unload confirm" prompt. Spec §4.0.B.
  window.addEventListener('beforeunload', function(e) {
    var anyDirty = false;
    tabs.forEach(function(container) {
      container.viewers.forEach(function(v) {
        if (v && typeof v.isDirty === 'function' && v.isDirty()) anyDirty = true;
      });
    });
    if (!anyDirty) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  async function loadPersistedCards(sid) {
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/file-edits/cards');
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  // ── File picker (V3.1, slimmed for V3.2) ─────────────────────────────
  var PICKER_FETCH_DEBOUNCE_MS = 100;
  var PICKER_RESULT_CAP = 50;
  var pickerEl = null;
  var pickerInput = null;
  var pickerList = null;
  var pickerOpen = false;
  var pickerResults = [];
  var pickerSelectedIdx = 0;
  // V3.y.2 fix: flat ordered list of all selectable picker items
  // (recents + results). Each entry is { rel: string, recent: bool }.
  // Used by keyboard nav so selection covers the entire visible list.
  var pickerVisible = [];
  var pickerLastQuery = '';
  var pickerFetchToken = 0;
  var pickerFetchTimer = null;
  var pickerOpenAbort = null;
  var pickerOutsideHandler = null;

  function ensurePickerEl() {
    if (pickerEl) return;
    pickerEl = document.createElement('div');
    pickerEl.className = 'fe-picker';
    pickerEl.hidden = true;
    pickerInput = document.createElement('input');
    pickerInput.className = 'fe-picker-input';
    pickerInput.type = 'text';
    pickerInput.setAttribute('placeholder', 'Search files…');
    pickerInput.setAttribute('spellcheck', 'false');
    pickerInput.setAttribute('autocomplete', 'off');
    pickerList = document.createElement('ul');
    pickerList.className = 'fe-picker-list';
    pickerEl.appendChild(pickerInput);
    pickerEl.appendChild(pickerList);
    rootEl.appendChild(pickerEl);

    pickerInput.addEventListener('input', function() {
      var q = pickerInput.value;
      pickerLastQuery = q;
      if (pickerFetchTimer) clearTimeout(pickerFetchTimer);
      pickerFetchTimer = setTimeout(function() { void runPickerFetch(q); }, PICKER_FETCH_DEBOUNCE_MS);
    });
    pickerInput.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePickerSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePickerSelection(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var entry = pickerVisible[pickerSelectedIdx];
        if (entry) pickSelected(entry.rel);
      } else if (e.key === 'Escape') {
        // Stop propagation so the input-router's Escape leader
        // timer doesn't arm when the picker eats the keystroke.
        e.preventDefault();
        e.stopPropagation();
        closePicker();
      } else if (e.key === 'Backspace' && pickerInput.value === '') {
        e.preventDefault();
        closePicker();
      }
    });
    pickerList.addEventListener('mousedown', function(e) {
      // V4: copy-button branch FIRST so the click does not advance
      // selection, close the picker, or be eaten by the disabled
      // early-return on (open) rows. See spec §5.3 / §6.6.
      var copyEl = e.target.closest('.fe-picker-copy');
      if (copyEl) {
        e.preventDefault();
        e.stopPropagation();
        void _pickerCopyPath(copyEl.dataset.path || '', copyEl);
        return;
      }
      var target = e.target.closest('.fe-picker-item');
      if (!target) return;
      e.preventDefault();
      if (target.classList.contains('disabled')) return;
      var flatIdx = Number(target.dataset.flatIdx);
      var entry = pickerVisible[flatIdx];
      if (entry) pickSelected(entry.rel);
    });
  }

  // ── V3.y.2 finder enhancements ────────────────────────────────────────
  // Recent files: last RECENT_FILES_CAP opens, persisted in
  // localStorage. See docs/files-applet-v3.y.md §4.2.D.
  var RECENT_FILES_KEY = 'caco:files-applet:recentPaths';
  var RECENT_FILES_CAP = 20;
  function _loadRecentFiles() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(RECENT_FILES_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function(x) { return typeof x === 'string'; }) : [];
    } catch (_e) { return []; }
  }
  function _pushRecentFile(absOrRel) {
    if (!absOrRel) return;
    try {
      var abs = absOrRel.charAt(0) === '/' ? absOrRel : absPathOf(absOrRel);
      var list = _loadRecentFiles();
      var idx = list.indexOf(abs);
      if (idx >= 0) list.splice(idx, 1);
      list.unshift(abs);
      if (list.length > RECENT_FILES_CAP) list.length = RECENT_FILES_CAP;
      window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
    } catch (_e) { /* ignore */ }
  }
  /** Fuzzy score, ported from applets/file-finder/script.js. */
  function _fuzzyScore(query, target) {
    var q = query.toLowerCase();
    var t = target.toLowerCase();
    if (t.indexOf(q) !== -1) return 100 + (q.length / t.length) * 50;
    var qi = 0;
    var score = 0;
    var lastMatch = -1;
    for (var ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += 10;
        if (lastMatch === ti - 1) score += 5;
        if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.') score += 8;
        lastMatch = ti;
        qi++;
      }
    }
    return qi === q.length ? score : 0;
  }
  /** Extension membership in a type-filter group. */
  function _matchesTypeFilter(rel, filter) {
    if (!filter) return true;
    var ext = (rel.split('.').pop() || '').toLowerCase();
    if (filter === 'img') return /^(png|jpg|jpeg|gif|webp|svg|ico)$/.test(ext);
    if (filter === 'md')  return /^(md|markdown|mdx)$/.test(ext);
    if (filter === 'html') return /^(html|htm)$/.test(ext);
    if (filter === 'diff') return !/^(png|jpg|jpeg|gif|webp|svg|ico|md|markdown|mdx|html|htm)$/.test(ext);
    return true;
  }
  /** Parse the type-filter prefix from a query. Returns
   *  { filter: string|null, rest: string } where filter is one of
   *  img/md/html/diff or null. */
  function _parseTypeFilter(q) {
    var m = (q || '').match(/^>(img|md|html|diff|any)(?:\s+|$)(.*)$/);
    if (!m) return { filter: null, rest: q || '' };
    return { filter: m[1] === 'any' ? null : m[1], rest: m[2] || '' };
  }

  /** Picker state — kept here so V3.y.2's openPicker(opts) can
   *  cooperate with the existing closePicker / runPickerFetch. */
  var _pickerSource = null;
  var _pickerPriorFocus = null;
  var _pickerTypeFilter = null;
  /** V5: one-shot directory root override for the picker. Set by
   *  openPicker({ rootOverride }); cleared by closePicker. When
   *  set, runPickerFetch uses it in place of cachedCwd, and
   *  _pickerAbsPathOf resolves picked rels against it. Enables
   *  ?applet=files&openFinder=1&openFinderRoot=ABS for new-chat
   *  Ctrl+P and the file-finder stub redirect. */
  var _pickerRootOverride = null;

  // V4: per-type icons + hover copy-path. Deliberate verbatim copy
  // of applets/file-finder/script.js fileIcons (parity, not shared
  // state). Roadmap V5+ consolidates. See docs/files-applet-v4.md.
  var _PICKER_FILE_ICONS = {
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
    json: '📋', md: '📝', txt: '📝',
    html: '🌐', css: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    sh: '⚙️', bash: '⚙️'
  };
  function _pickerIconFor(rel) {
    var ext = String(rel || '').split('.').pop().toLowerCase();
    return _PICKER_FILE_ICONS[ext] || '📄';
  }
  /** Copy `abs` to clipboard; flash ✓ / ✗ on `btn` with an 800 ms
   *  restore. `dataset.busy` lifecycle per spec §6.7 prevents
   *  concurrent clicks racing the restore timer. */
  async function _pickerCopyPath(abs, btn) {
    if (!abs || !btn) return;
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    var row = btn.closest('.fe-picker-item');
    var ok = false;
    try {
      await navigator.clipboard.writeText(abs);
      ok = true;
    } catch (_e) { ok = false; }
    btn.textContent = ok ? '✓' : '✗';
    if (row) row.classList.add('copied');
    var timer = setTimeout(function() {
      btn.textContent = '📋';
      if (row) row.classList.remove('copied');
      delete btn.dataset.busy;
      delete btn.dataset.restoreTimer;
    }, 800);
    btn.dataset.restoreTimer = String(timer);
  }

  function openPicker(opts) {
    opts = opts || {};
    if ((!sessionId && !opts.rootOverride) || pickerOpen) return;
    if (typeof opts.rootOverride === 'string' && opts.rootOverride) {
      _pickerRootOverride = opts.rootOverride;
    } else {
      _pickerRootOverride = null;
    }
    _pickerSource = opts.source || 'button';
    if (_pickerSource === 'shortcut') {
      _pickerPriorFocus = document.activeElement;
    }
    ensurePickerEl();
    pickerOpen = true;
    pickerEl.hidden = false;
    pickerInput.value = '';
    pickerLastQuery = '';
    pickerSelectedIdx = 0;
    pickerResults = [];
    pickerVisible = [];
    _pickerTypeFilter = null;
    renderPickerList();
    void runPickerFetch('');
    setTimeout(function() { pickerInput.focus(); }, 0);
    setTimeout(function() {
      pickerOutsideHandler = function(ev) {
        if (!pickerEl.contains(ev.target) && ev.target !== openBtn) closePicker();
      };
      document.addEventListener('mousedown', pickerOutsideHandler);
    }, 0);
  }

  function closePicker() {
    if (!pickerOpen) return;
    pickerOpen = false;
    if (pickerEl) pickerEl.hidden = true;
    if (pickerFetchTimer) { clearTimeout(pickerFetchTimer); pickerFetchTimer = null; }
    if (pickerOutsideHandler) {
      document.removeEventListener('mousedown', pickerOutsideHandler);
      pickerOutsideHandler = null;
    }
    // V3.y.2: restore prior focus on shortcut-opened picker so
    // Ctrl+P → Esc lands the user back where they started.
    if (_pickerPriorFocus && typeof _pickerPriorFocus.focus === 'function') {
      try { _pickerPriorFocus.focus(); } catch (_e) { /* ignore */ }
    }
    _pickerPriorFocus = null;
    _pickerSource = null;
    _pickerTypeFilter = null;
    _pickerRootOverride = null;
  }

  async function runPickerFetch(q) {
    if (!sessionId && !_pickerRootOverride) return;
    // V3.y.2: parse type-filter prefix; fetch with the post-filter
    // query string so the server's substring match is unaffected.
    var parsed = _parseTypeFilter(q);
    _pickerTypeFilter = parsed.filter;
    var fetchQ = parsed.rest;
    var token = ++pickerFetchToken;
    var rootForFetch = _pickerRootOverride || cachedCwd || '';
    var url = '/api/project-files?cwd=' + encodeURIComponent(rootForFetch);
    if (fetchQ) url += '&q=' + encodeURIComponent(fetchQ);
    try {
      var res = await fetch(url);
      if (!res.ok) return;
      var data = await res.json();
      if (token !== pickerFetchToken) return;
      var files = data.files || [];
      // Type filter.
      if (_pickerTypeFilter) {
        files = files.filter(function(p) { return _matchesTypeFilter(p, _pickerTypeFilter); });
      }
      // Fuzzy rank when there's a query; preserve server order otherwise.
      if (fetchQ) {
        files = files
          .map(function(p) { return { p: p, s: _fuzzyScore(fetchQ, p) }; })
          .filter(function(o) { return o.s > 0; })
          .sort(function(a, b) { return b.s - a.s; })
          .map(function(o) { return o.p; });
      }
      pickerResults = files.slice(0, PICKER_RESULT_CAP);
      pickerSelectedIdx = 0;
      renderPickerList();
    } catch (_) { /* ignore */ }
  }

  function renderPickerList() {
    if (!pickerList) return;
    pickerList.innerHTML = '';
    pickerVisible = [];

    // V3.y.2: filter chip when an active type-filter is set.
    if (_pickerTypeFilter) {
      var chip = document.createElement('li');
      chip.className = 'fe-picker-chip';
      chip.textContent = 'filter:' + _pickerTypeFilter + ' ✕';
      chip.title = 'Click to clear filter';
      chip.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        pickerInput.value = pickerInput.value.replace(/^>(img|md|html|diff|any)(?:\s+|$)/, '');
        pickerLastQuery = pickerInput.value;
        if (pickerFetchTimer) clearTimeout(pickerFetchTimer);
        void runPickerFetch(pickerInput.value);
      });
      pickerList.appendChild(chip);
    }

    // V3.y.2: recent files (when query is empty).
    var hasQuery = pickerLastQuery && pickerLastQuery.length > 0;
    if (!hasQuery) {
      var recents = _loadRecentFiles();
      if (recents.length > 0) {
        var rh = document.createElement('li');
        rh.className = 'fe-picker-section';
        rh.textContent = 'Recent';
        pickerList.appendChild(rh);
        var shown = recents.slice(0, 10);
        for (var ri = 0; ri < shown.length; ri++) {
          var rp = shown[ri];
          var rli = document.createElement('li');
          rli.className = 'fe-picker-item fe-picker-recent';
          var rRel = _relativizePath(rp);
          var rFlat = pickerVisible.length;
          pickerVisible.push({ rel: rRel, recent: true });
          rli.dataset.flatIdx = String(rFlat);
          if (rFlat === pickerSelectedIdx) rli.classList.add('selected');
          var ricon = document.createElement('span');
          ricon.className = 'fe-picker-icon';
          ricon.textContent = _pickerIconFor(rp);
          rli.appendChild(ricon);
          var rlabel = document.createElement('span');
          rlabel.className = 'fe-picker-path';
          rlabel.textContent = rp;
          rli.appendChild(rlabel);
          var rcopy = document.createElement('span');
          rcopy.className = 'fe-picker-copy';
          rcopy.textContent = '📋';
          rcopy.title = 'Copy absolute path';
          rcopy.dataset.path = rp;
          rli.appendChild(rcopy);
          pickerList.appendChild(rli);
        }
        if (pickerResults.length > 0) {
          var fh = document.createElement('li');
          fh.className = 'fe-picker-section';
          fh.textContent = 'Files';
          pickerList.appendChild(fh);
        }
      }
    }

    for (var i = 0; i < pickerResults.length; i++) {
      var p = pickerResults[i];
      var li = document.createElement('li');
      li.className = 'fe-picker-item';
      var flat = pickerVisible.length;
      pickerVisible.push({ rel: p, recent: false });
      li.dataset.flatIdx = String(flat);
      if (flat === pickerSelectedIdx) li.classList.add('selected');
      var icon = document.createElement('span');
      icon.className = 'fe-picker-icon';
      icon.textContent = _pickerIconFor(p);
      li.appendChild(icon);
      var label = document.createElement('span');
      label.className = 'fe-picker-path';
      label.textContent = p;
      li.appendChild(label);
      if (tabs.has(p)) {
        li.classList.add('disabled');
        var sfx = document.createElement('span');
        sfx.className = 'fe-picker-suffix';
        sfx.textContent = '(open)';
        li.appendChild(sfx);
      }
      var copy = document.createElement('span');
      copy.className = 'fe-picker-copy';
      copy.textContent = '📋';
      copy.title = 'Copy absolute path';
      copy.dataset.path = _pickerAbsPathOf(p);
      li.appendChild(copy);
      pickerList.appendChild(li);
    }

    if (pickerSelectedIdx >= pickerVisible.length) pickerSelectedIdx = 0;
  }

  function movePickerSelection(delta) {
    if (pickerVisible.length === 0) return;
    pickerSelectedIdx = (pickerSelectedIdx + delta + pickerVisible.length) % pickerVisible.length;
    var items = pickerList.querySelectorAll('.fe-picker-item');
    items.forEach(function(el) {
      var fi = Number(el.dataset.flatIdx);
      el.classList.toggle('selected', fi === pickerSelectedIdx);
    });
    for (var i = 0; i < items.length; i++) {
      if (Number(items[i].dataset.flatIdx) === pickerSelectedIdx) {
        items[i].scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }

  function pickSelected(relativePath) {
    closePicker();
    void routeOpen(relativePath);
  }

  /** Compute absolute path for a relative path under the session's cwd.
   *  Light-weight join — does not normalise '..' (the server validates). */
  function absPathOf(relativePath) {
    if (!cachedCwd) return relativePath;
    var sep = cachedCwd.indexOf('\\') >= 0 && cachedCwd.indexOf('/') < 0 ? '\\' : '/';
    var trimmed = cachedCwd.replace(/[\/\\]+$/, '');
    return trimmed + sep + relativePath;
  }

  /** V5: resolve a picker-relative path against _pickerRootOverride
   *  when set, else fall back to absPathOf (which uses cachedCwd).
   *  Used by routeOpen and the picker copy button so a no-session
   *  ?openFinderRoot=ABS picker opens / copies the correct file. */
  function _pickerAbsPathOf(relativePath) {
    if (_pickerRootOverride) {
      var trimmed = _pickerRootOverride.replace(/[\/\\]+$/, '');
      var sep = trimmed.indexOf('\\') >= 0 && trimmed.indexOf('/') < 0 ? '\\' : '/';
      return trimmed + sep + relativePath;
    }
    return absPathOf(relativePath);
  }

  /** Route a picked relative path: build a TabContainer with the
   *  file's default viewer, attach DOM, activate. See spec
   *  §4.0.B / §4.1.
   *
   *  V6: openOpts.diffMode threads through to TabContainer (for
   *  diffTabId disambiguation) and to the viewer's open call.
   *  Mode-aware findContainerByRelPath so a staged-mode deep
   *  link doesn't focus an existing unstaged tab.
   */
  async function routeOpen(relativePath, openOpts) {
    openOpts = openOpts || {};
    var diffMode = openOpts.diffMode || 'unstaged';
    var abs = _pickerAbsPathOf(relativePath);
    // If a container already exists for THIS mode, just activate.
    var existing = findContainerByRelPath(relativePath, { mode: diffMode });
    if (existing) {
      followEdits = false;
      updateFollowButton();
      setActiveTab(existing.id);
      _pushRecentFile(abs);
      return;
    }
    // Idempotency guard: if a concurrent routeOpen is already in
    // flight for this relPath (e.g. cold-load race between
    // initFromPersistence and onUrlParamsChange, or rapid double-
    // click), short-circuit. The pendingOpenIds key includes mode
    // so opening unstaged + staged of the same file concurrently
    // doesn't dedup.
    var pendKey = diffMode === 'unstaged'
      ? relativePath
      : '\u0000' + diffMode + '\u0000' + relativePath;
    if (pendingOpenIds.has(pendKey)) return;
    pendingOpenIds.add(pendKey);
    var desc = defaultViewer(abs, relativePath);
    if (!desc) {
      console.warn('[files-applet] no viewer for', relativePath);
      pendingOpenIds.delete(pendKey);
      return;
    }
    // V6: thread diffMode into the descriptor so the TabContainer
    // constructor's diffTabId call sees it.
    if (desc.viewerType === 'diff' && diffMode !== 'unstaged') {
      desc = Object.assign({}, desc, { diffMode: diffMode });
    }
    if (tabs.size >= TAB_CAP) evictOldestNonActive();
    var container = new TabContainer(shell, desc, abs, relativePath);
    try {
      var viewer = await desc.open(shell, container, abs, relativePath, {
        diffMode: diffMode,
      });
      // Re-check after await: another caller may have created the
      // tab while we were suspended. Discard our container if so.
      var raceCheck = findContainerByRelPath(relativePath, { mode: diffMode });
      if (raceCheck) {
        if (viewer && typeof viewer.destroy === 'function') {
          try { viewer.destroy(); } catch (_e) { /* ignore */ }
        }
        container.destroy();
        setActiveTab(raceCheck.id);
        _pushRecentFile(abs);
        return;
      }
      if (!viewer) { container.destroy(); return; }
      container.viewers.set(desc.viewerType, viewer);
    } catch (err) {
      if (err && err.name === 'AbortError') { container.destroy(); return; }
      console.warn('[files-applet] routeOpen failed', relativePath, err);
      container.destroy();
      return;
    } finally {
      pendingOpenIds.delete(pendKey);
    }
    tabs.set(container.id, container);
    tabsEl.appendChild(container.tabEl);
    paneEl.appendChild(container.contentEl);
    container.updateToggle();
    followEdits = false;
    updateFollowButton();
    setActiveTab(container.id);
    updateEmptyState();
    reconcileTabDom();
    _pushRecentFile(abs);
  }

  // ── Viewer registration ──────────────────────────────────────────────
  // Order matters: isDefault is checked in registration order, first
  // match wins. Markdown/image registered before Diff so they win for
  // their respective extensions; Diff is the universal fallback for
  // non-binary files.
  if (MarkdownViewer) {
    registerViewer({
      viewerType: 'markdown',
      label: 'Markdown',
      canHandle: function(_a, rel) {
        return /\.(md|markdown|mdx)$/i.test(rel || '');
      },
      isDefault: function(_a, rel) {
        return /\.(md|markdown|mdx)$/i.test(rel || '');
      },
      open: function(s, c, a, r) { return MarkdownViewer.open(s, c, a, r); },
    });
  }
  if (ImageViewer) {
    registerViewer({
      viewerType: 'image',
      label: 'Image',
      canHandle: function(_a, rel) {
        return /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(rel || '');
      },
      isDefault: function(_a, rel) {
        return /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(rel || '');
      },
      open: function(s, c, a, r) { return ImageViewer.open(s, c, a, r); },
    });
  }
  if (HtmlViewer) {
    registerViewer({
      viewerType: 'html',
      label: 'HTML',
      canHandle: function(_a, rel) { return /\.html?$/i.test(rel || ''); },
      isDefault: function(_a, rel) { return /\.html?$/i.test(rel || ''); },
      open: function(s, c, a, r) { return HtmlViewer.open(s, c, a, r); },
    });
  }
  if (DiffViewer) {
    registerViewer({
      viewerType: 'diff',
      label: 'Diff',
      canHandle: function(_a, rel) { return !isBinaryExtension(rel); },
      isDefault: function(_a, rel) { return !isBinaryExtension(rel); },
      open: function(s, c, a, r, opts) { return DiffViewer.open(s, c, a, r, opts); },
    });
  }

  openBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (pickerOpen) closePicker();
    else openPicker();
  });

  // ── Pure utilities (preserved from V2/V2.1/V3.1) ─────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function statusLabel(status) {
    switch (status) {
      case 'modified': return 'M';
      case 'untracked': return 'U';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'clean': return '✓';
      default: return '?';
    }
  }

  /** Threshold above which a run of unchanged context rows is folded by
   *  default. Folds are click-to-expand and re-collapsible. */
  var FOLD_THRESHOLD = 20;

  /** Map of file extension → highlight.js language key. Used by Phase 1
   *  syntax highlighting; entries not present here render without
   *  highlighting (silent fallback). Only keys present in the vendored
   *  highlight.min.js bundle are listed here; getLanguage() guards anyway. */
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

  function detectLanguage(relativePath) {
    if (!relativePath) return null;
    var m = /\.([A-Za-z0-9_]+)$/.exec(relativePath);
    if (!m) return null;
    return EXT_TO_LANG[m[1].toLowerCase()] || null;
  }

  /** Walk hunks and headLines/workLines into an ordered row list. See
   *  docs/file-edits-v2.md §Phase 1 Render → Merge walk. Pure function. */
  function buildRows(headLines, workLines, hunks) {
    var rows = [];
    var hasHead = Array.isArray(headLines);
    var h = 1, w = 1; // 1-indexed cursors
    for (var hi = 0; hi < hunks.length; hi++) {
      var hunk = hunks[hi];
      // Emit unchanged context between previous position and this hunk.
      while (h < hunk.headStart && hasHead && h - 1 < headLines.length) {
        rows.push({ kind: 'ctx', head: h, work: w, text: headLines[h - 1] });
        h++; w++;
      }
      // Emit removed lines (from HEAD).
      for (var i = 0; i < hunk.headLen; i++) {
        var headText = hasHead && h - 1 < headLines.length ? headLines[h - 1] : '';
        rows.push({ kind: 'del', head: h, work: null, text: headText });
        h++;
      }
      // Emit added lines (from working tree).
      for (var j = 0; j < hunk.workLen; j++) {
        var workText = w - 1 < workLines.length ? workLines[w - 1] : '';
        rows.push({ kind: 'add', head: null, work: w, text: workText });
        w++;
      }
    }
    // Emit unchanged tail.
    if (hasHead) {
      while (h - 1 < headLines.length) {
        rows.push({ kind: 'ctx', head: h, work: w, text: headLines[h - 1] });
        h++; w++;
      }
    }
    return rows;
  }

  /** Collapse runs of >FOLD_THRESHOLD consecutive ctx rows into a single
   *  fold row. Preserves the original rows inside `hidden` so click-expand
   *  can restore them. Pure function. */
  function collapseFolds(rows) {
    var out = [];
    var i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== 'ctx') {
        out.push(rows[i]);
        i++;
        continue;
      }
      var start = i;
      while (i < rows.length && rows[i].kind === 'ctx') i++;
      var runLen = i - start;
      if (runLen > FOLD_THRESHOLD) {
        out.push({
          kind: 'fold',
          count: runLen,
          headStart: rows[start].head,
          workStart: rows[start].work,
          hidden: rows.slice(start, i),
        });
      } else {
        for (var k = start; k < i; k++) out.push(rows[k]);
      }
    }
    return out;
  }

  /** Pad a number (or blank) to a fixed-width string for the gutter. */
  function gutterText(n) {
    return n == null ? '' : String(n);
  }

  // ── Phase 2: Word-level intra-line diff ──────────────────────────────

  /** Tokenize a line into a sequence of word + non-word tokens. Whitespace
   *  and punctuation are kept as separate tokens so the diff can identify
   *  changed words without dragging surrounding context along.
   *  Pure function. */
  function tokenize(line) {
    if (!line) return [];
    // Match runs of [A-Za-z0-9_] OR runs of whitespace OR single non-word chars.
    // This keeps multi-char identifiers together while keeping punctuation
    // splittable. \s+ lumps spaces so a 4-space indent is one token.
    var re = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g;
    var out = [];
    var m;
    while ((m = re.exec(line)) !== null) out.push(m[0]);
    return out;
  }

  /** Myers O(ND) diff on two token arrays. Returns an array of ops
   *  [{kind: 'equal'|'del'|'add', tokens: string[]}] in source order.
   *
   *  This is the classic Myers algorithm operating on strings (token
   *  arrays). We compute the V array of furthest-reaching x values per
   *  diagonal k for each edit-distance d, snapshot V per d, then walk
   *  back to reconstruct the path.
   *
   *  Bounded by line length: per-line token counts are small (typically
   *  <100), so the worst-case O((N+M)*D) is trivial.
   *  Pure function. */
  function myersDiff(a, b) {
    var n = a.length, m = b.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) return [{ kind: 'add', tokens: b.slice() }];
    if (m === 0) return [{ kind: 'del', tokens: a.slice() }];
    var max = n + m;
    var vSize = 2 * max + 1;
    var offset = max;
    var v = new Int32Array(vSize);
    var trace = [];
    var d, k, x, y, prevK;
    outer: for (d = 0; d <= max; d++) {
      var vSnap = new Int32Array(vSize);
      for (k = -d; k <= d; k += 2) {
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1]; // down (insert from b)
        } else {
          x = v[offset + k - 1] + 1; // right (delete from a)
        }
        y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          vSnap.set(v);
          trace.push(vSnap);
          break outer;
        }
      }
      vSnap.set(v);
      trace.push(vSnap);
    }
    // Backtrack
    var ops = [];
    x = n; y = m;
    for (var dd = trace.length - 1; dd > 0; dd--) {
      var vPrev = trace[dd - 1];
      k = x - y;
      if (k === -dd || (k !== dd && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      var prevX = vPrev[offset + prevK];
      var prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        ops.push({ kind: 'equal', token: a[x - 1] });
        x--; y--;
      }
      if (dd > 0) {
        if (x === prevX) {
          ops.push({ kind: 'add', token: b[y - 1] });
          y--;
        } else {
          ops.push({ kind: 'del', token: a[x - 1] });
          x--;
        }
      }
    }
    while (x > 0 && y > 0) {
      ops.push({ kind: 'equal', token: a[x - 1] });
      x--; y--;
    }
    while (x > 0) { ops.push({ kind: 'del', token: a[--x] }); }
    while (y > 0) { ops.push({ kind: 'add', token: b[--y] }); }
    ops.reverse();
    // Coalesce adjacent same-kind ops into runs of tokens.
    var coalesced = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (coalesced.length > 0 && coalesced[coalesced.length - 1].kind === op.kind) {
        coalesced[coalesced.length - 1].tokens.push(op.token);
      } else {
        coalesced.push({ kind: op.kind, tokens: [op.token] });
      }
    }
    return coalesced;
  }

  /** From a diff op stream, compute char ranges on each side that should
   *  be marked. side='del' wants char ranges into the original (a) string;
   *  side='add' wants ranges into the new (b) string.
   *
   *  Returns { delRanges: [{start, end}], addRanges: [{start, end}] } with
   *  half-open intervals into the joined token text.
   *  Pure function. */
  function rangesFromOps(ops) {
    var delRanges = [];
    var addRanges = [];
    var aPos = 0, bPos = 0;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var text = op.tokens.join('');
      if (op.kind === 'equal') {
        aPos += text.length;
        bPos += text.length;
      } else if (op.kind === 'del') {
        if (text.length > 0) delRanges.push({ start: aPos, end: aPos + text.length });
        aPos += text.length;
      } else { // add
        if (text.length > 0) addRanges.push({ start: bPos, end: bPos + text.length });
        bPos += text.length;
      }
    }
    // Drop pure-whitespace ranges — marking the gap between two unchanged
    // tokens (e.g. one extra space) is noisy and not useful.
    function dropPureWhitespace(ranges, source) {
      var out = [];
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        var slice = source.substring(r.start, r.end);
        if (/\S/.test(slice)) out.push(r);
      }
      return out;
    }
    return {
      delRanges: delRanges,
      addRanges: addRanges,
      filter: function(aText, bText) {
        return {
          delRanges: dropPureWhitespace(delRanges, aText),
          addRanges: dropPureWhitespace(addRanges, bText),
        };
      },
    };
  }

  /** Compute word-mark ranges for one (delLine, addLine) pair. Returns
   *  { delRanges, addRanges }. Pure function. */
  function wordMarksForPair(delText, addText) {
    var aTok = tokenize(delText);
    var bTok = tokenize(addText);
    var ops = myersDiff(aTok, bTok);
    // If the pair shares no non-whitespace tokens at all (totally rewritten
    // line), skip word marks — the line-level red/green already conveys
    // "all changed" and word marks would just light up the entire line.
    // Shared whitespace doesn't count: two unrelated lines often share
    // indent or spaces.
    var hasEqual = false;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].kind === 'equal' && /\S/.test(ops[i].tokens.join(''))) {
        hasEqual = true;
        break;
      }
    }
    if (!hasEqual) return { delRanges: [], addRanges: [] };
    var raw = rangesFromOps(ops);
    return raw.filter(delText, addText);
  }

  /** Walk the rows list, group consecutive (del+, add+) blocks, pair lines
   *  in order up to min(N,M). Returns a Map<rowIndex, { delRanges|addRanges }>
   *  so the renderer can attach marks per row. Pure function. */
  function computeAllWordMarks(rows) {
    var marks = new Map();
    var i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== 'del') { i++; continue; }
      // Collect run of dels.
      var delStart = i;
      while (i < rows.length && rows[i].kind === 'del') i++;
      var dels = rows.slice(delStart, i);
      // Adjacent run of adds.
      var addStart = i;
      while (i < rows.length && rows[i].kind === 'add') i++;
      var adds = rows.slice(addStart, i);
      var pairs = Math.min(dels.length, adds.length);
      for (var p = 0; p < pairs; p++) {
        var delIdx = delStart + p;
        var addIdx = addStart + p;
        var marksPair = wordMarksForPair(rows[delIdx].text, rows[addIdx].text);
        if (marksPair.delRanges.length > 0) {
          marks.set(delIdx, { ranges: marksPair.delRanges, kind: 'del' });
        }
        if (marksPair.addRanges.length > 0) {
          marks.set(addIdx, { ranges: marksPair.addRanges, kind: 'add' });
        }
      }
    }
    return marks;
  }

  /** Inject <mark class="fe-w-{kind}"> spans into a code element at the
   *  given char ranges. Walks text nodes via TreeWalker; splits text nodes
   *  at range boundaries; wraps each fragment in a <mark>. Preserves any
   *  nested hljs span structure — the wrap is applied around text fragments
   *  without re-parenting their ancestor spans.
   *
   *  Ranges are half-open intervals into the code element's textContent. */
  function injectMarks(codeEl, ranges, kind) {
    if (!ranges || ranges.length === 0) return;
    // Build a sorted list of cut points (offsets) and a per-range membership
    // lookup so we know whether the fragment between two cuts is "marked".
    var cuts = [];
    for (var i = 0; i < ranges.length; i++) {
      cuts.push(ranges[i].start);
      cuts.push(ranges[i].end);
    }
    cuts.sort(function(a, b) { return a - b; });
    function isMarked(offset) {
      for (var i = 0; i < ranges.length; i++) {
        if (offset >= ranges[i].start && offset < ranges[i].end) return true;
      }
      return false;
    }
    // First pass: collect text nodes and their absolute offsets.
    var walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    var node, cursor = 0;
    while ((node = walker.nextNode()) !== null) {
      textNodes.push({ node: node, start: cursor, end: cursor + node.nodeValue.length });
      cursor += node.nodeValue.length;
    }
    // Second pass: for each text node, build a sequence of (offset, marked)
    // fragments and rewrite the DOM around it.
    var className = 'fe-w-' + kind;
    for (var t = 0; t < textNodes.length; t++) {
      var tn = textNodes[t];
      var local = []; // offsets inside this node where the marked flag flips
      local.push(0);
      for (var c = 0; c < cuts.length; c++) {
        var rel = cuts[c] - tn.start;
        if (rel > 0 && rel < (tn.end - tn.start)) local.push(rel);
      }
      local.push(tn.end - tn.start);
      if (local.length === 2) {
        // No cuts inside this node; wrap whole or skip whole.
        if (isMarked(tn.start)) {
          var wholeMark = document.createElement('mark');
          wholeMark.className = className;
          wholeMark.textContent = tn.node.nodeValue;
          tn.node.parentNode.replaceChild(wholeMark, tn.node);
        }
        continue;
      }
      // Multiple fragments inside this node.
      var parent = tn.node.parentNode;
      var anchor = tn.node.nextSibling;
      parent.removeChild(tn.node);
      for (var s = 0; s < local.length - 1; s++) {
        var frag = tn.node.nodeValue.substring(local[s], local[s + 1]);
        if (frag.length === 0) continue;
        if (isMarked(tn.start + local[s])) {
          var mk = document.createElement('mark');
          mk.className = className;
          mk.textContent = frag;
          parent.insertBefore(mk, anchor);
        } else {
          parent.insertBefore(document.createTextNode(frag), anchor);
        }
      }
    }
  }

  // ── End Phase 2 ───────────────────────────────────────────────────────

  /** Build a single non-fold row element. `mark`, if present, is
   *  { ranges: [{start,end}], kind: 'add'|'del' } and triggers
   *  word-level <mark> injection after highlighting. */
  function buildRowEl(row, lang, mark) {
    var div = document.createElement('div');
    div.className = 'fe-row fe-row-' + row.kind;
    if (row.work != null) div.dataset.workLine = String(row.work);
    var gHead = document.createElement('span');
    gHead.className = 'fe-gutter fe-gutter-head';
    gHead.textContent = gutterText(row.head);
    var gWork = document.createElement('span');
    gWork.className = 'fe-gutter fe-gutter-work';
    gWork.textContent = gutterText(row.work);
    var code = document.createElement('code');
    code.className = 'fe-line';
    code.textContent = row.text;
    if (lang && window.hljs && window.hljs.getLanguage && window.hljs.getLanguage(lang)) {
      try {
        var hl = window.hljs.highlight(row.text, { language: lang, ignoreIllegals: true });
        code.innerHTML = hl.value;
        code.classList.add('hljs', 'language-' + lang);
      } catch (_) { /* silent fallback */ }
    }
    if (mark && mark.ranges && mark.ranges.length > 0) {
      injectMarks(code, mark.ranges, mark.kind);
    }
    div.appendChild(gHead);
    div.appendChild(gWork);
    div.appendChild(code);
    return div;
  }

  /** Build a fold row element. Click to expand into rendered ctx rows
   *  (with a collapse affordance prepended). */
  function buildFoldEl(row, lang) {
    var div = document.createElement('div');
    div.className = 'fe-row fe-row-fold';
    div.dataset.count = String(row.count);
    var gHead = document.createElement('span');
    gHead.className = 'fe-gutter fe-gutter-head';
    var gWork = document.createElement('span');
    gWork.className = 'fe-gutter fe-gutter-work';
    var btn = document.createElement('button');
    btn.className = 'fe-fold-btn';
    btn.type = 'button';
    btn.textContent = '… ' + row.count + ' unchanged line' + (row.count === 1 ? '' : 's') + ' …';
    btn.addEventListener('click', function() {
      expandFold(div, row, lang);
    });
    div.appendChild(gHead);
    div.appendChild(gWork);
    div.appendChild(btn);
    return div;
  }

  function expandFold(foldDiv, row, lang) {
    var frag = document.createDocumentFragment();
    var collapseRow = document.createElement('div');
    collapseRow.className = 'fe-row fe-row-collapse';
    var cgh = document.createElement('span'); cgh.className = 'fe-gutter fe-gutter-head';
    var cgw = document.createElement('span'); cgw.className = 'fe-gutter fe-gutter-work';
    var cBtn = document.createElement('button');
    cBtn.className = 'fe-fold-btn';
    cBtn.type = 'button';
    cBtn.textContent = '▲ collapse ' + row.count + ' lines';
    collapseRow.appendChild(cgh);
    collapseRow.appendChild(cgw);
    collapseRow.appendChild(cBtn);
    frag.appendChild(collapseRow);
    var expandedRows = [];
    for (var i = 0; i < row.hidden.length; i++) {
      var el = buildRowEl(row.hidden[i], lang, row.hidden[i].mark);
      expandedRows.push(el);
      frag.appendChild(el);
    }
    foldDiv.parentNode.replaceChild(frag, foldDiv);
    cBtn.addEventListener('click', function() {
      var newFold = buildFoldEl(row, lang);
      collapseRow.parentNode.insertBefore(newFold, collapseRow);
      collapseRow.parentNode.removeChild(collapseRow);
      for (var k = 0; k < expandedRows.length; k++) {
        if (expandedRows[k].parentNode) expandedRows[k].parentNode.removeChild(expandedRows[k]);
      }
    });
  }

  /** Render the full-file diff into `body`. Returns true if it rendered
   *  (fullFile usable), false to signal the caller should fall back to
   *  the v1 hunk renderer. */
  function renderFullFile(body, edit) {
    var ff = edit && edit.fullFile;
    if (!ff || !Array.isArray(ff.workLines)) return false;
    body.innerHTML = '';
    var rawRows = buildRows(ff.headLines, ff.workLines, ff.hunks || []);
    var marks = computeAllWordMarks(rawRows);
    marks.forEach(function(m, idx) { rawRows[idx].mark = m; });
    var rows = rawRows;
    // V3.2: a "clean" view (no add/del rows) shows a single line-number
    // column. The work column duplicates head for every ctx row, so the
    // second column is pure noise. Tag the body so CSS collapses the
    // grid to two columns.
    var hasAnyDiff = false;
    for (var k = 0; k < rows.length; k++) {
      if (rows[k].kind === 'add' || rows[k].kind === 'del') { hasAnyDiff = true; break; }
    }
    body.dataset.cleanOnly = hasAnyDiff ? 'false' : 'true';
    if (rows.length === 0) {
      body.innerHTML = '<div class="fe-d-empty">(no visible changes)</div>';
      return true;
    }
    var lang = detectLanguage(edit.relativePath);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      frag.appendChild(r.kind === 'fold' ? buildFoldEl(r, lang) : buildRowEl(r, lang, r.mark));
    }
    body.appendChild(frag);
    return true;
  }

  function renderDiff(diff) {
    if (!diff) return '<div class="fe-d-empty">(no diff)</div>';
    var lines = String(diff).split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Strip git's structural noise — the user only wants file content.
      if (line.startsWith('diff --git ')) continue;
      if (line.startsWith('index ')) continue;
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith('new file mode ')) continue;
      if (line.startsWith('deleted file mode ')) continue;
      if (line.startsWith('similarity index ')) continue;
      if (line.startsWith('rename from ')) continue;
      if (line.startsWith('rename to ')) continue;
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      var cls = 'fe-d-ctx';
      if (line.startsWith('@@')) cls = 'fe-d-hunk';
      else if (line.startsWith('+')) cls = 'fe-d-add';
      else if (line.startsWith('-')) cls = 'fe-d-del';
      // Each span is display:block; no trailing \n needed.
      html += '<span class="' + cls + '">' + esc(line) + '</span>';
    }
    if (!html) return '<div class="fe-d-empty">(no visible changes)</div>';
    return html;
  }

  /** Render a diff body using the V2 full-file renderer when fullFile is
   *  present, falling back to V1's hunk renderer otherwise. Updates the
   *  body element in place. */
  function renderBody(body, edit) {
    if (renderFullFile(body, edit)) {
      body.dataset.mode = 'fullfile';
      return;
    }
    body.innerHTML = renderDiff(edit && edit.diff);
    body.dataset.mode = 'hunk';
  }
  function fullFileEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    var hA = a.hunks || [], hB = b.hunks || [];
    if (hA.length !== hB.length) return false;
    for (var i = 0; i < hA.length; i++) {
      if (hA[i].headStart !== hB[i].headStart) return false;
      if (hA[i].headLen   !== hB[i].headLen)   return false;
      if (hA[i].workStart !== hB[i].workStart) return false;
      if (hA[i].workLen   !== hB[i].workLen)   return false;
    }
    var wA = a.workLines || [], wB = b.workLines || [];
    if (wA.length !== wB.length) return false;
    for (var j = 0; j < wA.length; j++) if (wA[j] !== wB[j]) return false;
    var headAEmpty = !a.headLines, headBEmpty = !b.headLines;
    if (headAEmpty !== headBEmpty) return false;
    if (!headAEmpty) {
      if (a.headLines.length !== b.headLines.length) return false;
      for (var k = 0; k < a.headLines.length; k++) {
        if (a.headLines[k] !== b.headLines[k]) return false;
      }
    }
    return true;
  }
  // ── Snapshot fetcher and session wiring ──────────────────────────────
  async function fetchSnapshot() {
    if (!sessionId) return;
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/snapshot');
      if (!res.ok) {
        if (res.status === 404) {
          notGitEl.hidden = false;
          paneEmptyEl.hidden = true;
        }
        return;
      }
      notGitEl.hidden = true;
      var data = await res.json();
      if (Array.isArray(data.edits)) {
        for (var i = 0; i < data.edits.length; i++) {
          openOrUpdateTab(data.edits[i]);
        }
      }
      updateEmptyState();
    } catch (err) {
      console.warn('[file-edits] snapshot failed:', err);
    }
  }

  async function initFromPersistence(sid) {
    var persisted = await loadPersistedCards(sid);
    if (persisted && Array.isArray(persisted.cards)) {
      // defaultViewerType is no longer trusted from disk — it is
      // always recomputed from the file's actual type via
      // defaultViewer() (the same picker routeOpen + openOrUpdateTab
      // use). This means a binary persisted as diff-default from a
      // pre-image-viewer build correctly rehydrates to its image
      // viewer with no special case needed.
      //
      // activeViewerType is honored only when it canHandle the file
      // (i.e. the user toggled to a still-valid alternate viewer);
      // otherwise it collapses to the default.
      var isV2 = persisted.schemaVersion === 2;
      persisted.cards.forEach(function(c) {
        if (!c || !c.relativePath) return;
        // V6: check by the computed id, not just relPath — a staged
        // tab for the same file would collide on the relPath check.
        var cardMode = c.diffMode || 'unstaged';
        var candidateId = cardMode === 'unstaged'
          ? c.relativePath
          : diffTabId({ mode: cardMode, relPath: c.relativePath });
        if (tabs.has(candidateId)) return;
        var abs = absPathOf(c.relativePath);
        var desc = defaultViewer(abs, c.relativePath);
        if (!desc) {
          console.warn('[files-applet] no viewer for persisted', c.relativePath);
          return;
        }
        var defaultType = desc.viewerType;
        var activeType = defaultType;
        if (isV2 && c.activeViewerType && c.activeViewerType !== defaultType) {
          for (var ai = 0; ai < viewerRegistry.length; ai++) {
            var ad = viewerRegistry[ai];
            if (ad.viewerType === c.activeViewerType && ad.canHandle(abs, c.relativePath)) {
              activeType = c.activeViewerType;
              break;
            }
          }
        }
        // V6: thread persisted diffMode into the descriptor so
        // TabContainer's diffTabId produces the matching id and
        // the async rehydrate path knows to call DiffViewer.open
        // with the right mode. cardMode was resolved above for the
        // dedup check. V6.1 removed diffRef / range.
        if (defaultType === 'diff' && cardMode !== 'unstaged') {
          desc = Object.assign({}, desc, { diffMode: cardMode });
        }
        var container = new TabContainer(shell, desc, abs, c.relativePath);
        if (defaultType === 'diff' && cardMode === 'unstaged') {
          // V1-V5 fast path: placeholder + fetchSnapshot updates with
          // working-tree state. Only valid for unstaged tabs.
          var placeholder = {
            relativePath: c.relativePath,
            path: '',
            status: 'clean',
            timestamp: new Date().toISOString(),
          };
          var viewer = DiffViewer.fromEdit(shell, container, placeholder);
          container.viewers.set('diff', viewer);
          tabs.set(container.id, container);
          tabsEl.appendChild(container.tabEl);
          paneEl.appendChild(container.contentEl);
          container.updateToggle();
        } else {
          // Async factory path (image, html, markdown, OR V6 staged
          // diff). Insert into tabs synchronously so caco.edit dedup
          // works; mark rehydrating; the factory completes
          // asynchronously.
          container.rehydrating = true;
          tabs.set(container.id, container);
          tabsEl.appendChild(container.tabEl);
          paneEl.appendChild(container.contentEl);
          container.updateToggle();
          (function() {
            var factoryContainer = container;
            var factoryDesc = desc;
            var factoryActive = activeType;
            var openOpts = (factoryDesc.viewerType === 'diff' && cardMode !== 'unstaged')
              ? { diffMode: cardMode }
              : undefined;
            desc.open(shell, container, abs, c.relativePath, openOpts).then(function(v) {
              if (factoryContainer.destroyed) {
                try { v.destroy(); } catch (_e) { /* ignore */ }
                return;
              }
              factoryContainer.viewers.set(factoryDesc.viewerType, v);
              factoryContainer.rehydrating = false;
              // Secondary viewer (active !== default) — switch in
              // sequence after the default is constructed. switchViewer
              // handles the lazy construct + activate.
              if (factoryActive !== factoryDesc.viewerType && !factoryContainer.destroyed) {
                void factoryContainer.switchViewer(factoryActive);
              }
              shell.echoState();
            }, function(err) {
              console.warn('[files-applet] rehydrate factory failed', c.relativePath, err);
              tabs.delete(factoryContainer.id);
              factoryContainer.destroy();
            });
          })();
        }
      });
    }
    updateEmptyState();
    await fetchSnapshot();
  }

  if (window.appletAPI) {
    if (typeof window.appletAPI.onStateUpdate === 'function') {
      window.appletAPI.onStateUpdate(function(state) {
        if (state && state.fileEdits) void applyAgentState(state.fileEdits);
      });
    }
    // V3.y.1: deep-link `?applet=file-edits&openPath=/abs` opens
    // the file as a new TabContainer. The cold-load case races
    // onSessionChange (which sets cachedCwd); queue and drain.
    // See docs/files-applet-v3.y.md §4.1.B.
    if (typeof window.appletAPI.onUrlParamsChange === 'function') {
      window.appletAPI.onUrlParamsChange(function(params) {
        if (!params) return;
        if (params.openPath) {
          // V6: optional diffMode (unstaged | staged) carried into
          // routeOpen. V6.1 removed diffRef.
          var routeOpts = {
            diffMode: params.diffMode || undefined,
          };
          if (cachedCwd) {
            _handleOpenPath(params.openPath, routeOpts);
          } else {
            _pendingOpenPath = { path: params.openPath, opts: routeOpts };
          }
          if (typeof window.appletAPI.navigateAppletUrlParam === 'function') {
            // Consume the params so back-traversal doesn't re-fire.
            // Use '' (not null) — the applet-runtime signature is
            // (key: string, value: string) with falsy=delete.
            window.appletAPI.navigateAppletUrlParam('openPath', '');
            if (params.diffMode) window.appletAPI.navigateAppletUrlParam('diffMode', '');
          }
        }
        if (params.openFinder) {
          // V3.y.2: Ctrl+P-triggered finder open. Picker function
          // is defined later in this IIFE; check before calling.
          // V5: openFinderRoot (optional) overrides cachedCwd for
          // the picker; supports new-chat and file-finder stub.
          if (typeof openPicker === 'function') {
            var rootOverride = params.openFinderRoot
              ? String(params.openFinderRoot)
              : undefined;
            openPicker({ source: 'shortcut', rootOverride: rootOverride });
          }
          if (typeof window.appletAPI.navigateAppletUrlParam === 'function') {
            window.appletAPI.navigateAppletUrlParam('openFinder', '');
            if (params.openFinderRoot) {
              window.appletAPI.navigateAppletUrlParam('openFinderRoot', '');
            }
          }
        }
      });
    }
    window.appletAPI.onSessionEvent(function(event) {
      if (event && event.type === 'caco.edit' && event.data) {
        var d = event.data;
        if (Array.isArray(d.edits)) {
          d.edits.forEach(function(e) { openOrUpdateTab(e); });
        }
        if (Array.isArray(d.cleanedEdits)) {
          d.cleanedEdits.forEach(function(e) { openOrUpdateTab(e); });
        }
        // d.cleared is ignored in V3.2 (tabs persist; clean is just a status)
      }
    });
    window.appletAPI.onSessionChange(function(sid, info) {
      // Flush outgoing session's pending PUT first. The captured body
      // (set by schedulePersist's last call) already reflects the
      // outgoing session's tab list, so this is safe even though we
      // clear `tabs` immediately below — flushPersist doesn't re-read
      // tabs, it uses the snapshot it captured.
      flushPersist();
      // Close picker and abort any in-flight open call.
      closePicker();
      if (pickerOpenAbort) { pickerOpenAbort.abort(); pickerOpenAbort = null; }
      // Drop any native Selection range pointing at rows we're about
      // to tear down; otherwise the browser's global Selection would
      // hold dangling references.
      var browserSel = window.getSelection && window.getSelection();
      if (browserSel) browserSel.removeAllRanges();
      // Tear down in-memory state. Rule §4.0.5.6: capture, clear
      // the map (and pointers), THEN destroy. This way any
      // tab-callback that re-enters the shell during destroy()
      // sees an empty map.
      var captured = Array.from(tabs.values());
      tabs.clear();
      badgeCounter.clear();
      lastEditedTabId = null;
      activeTabId = null;
      followEdits = true;
      cachedCwd = '';
      captured.forEach(function(t) {
        try { t.destroy(); } catch (err) { console.warn('[file-edits] destroy on session-switch:', err); }
      });
      // Drop dismissed-path state; the new session has its own working tree.
      dismissedPaths.clear();
      dismissedSnapshots.clear();
      // Re-add the persistent placeholder DIVs (they remain in
      // index.html's pane but the V3.5 code's innerHTML='' clear has
      // been removed; ensure they're still children defensively).
      if (paneEmptyEl.parentNode !== paneEl) paneEl.appendChild(paneEmptyEl);
      if (notGitEl.parentNode !== paneEl) paneEl.appendChild(notGitEl);
      notGitEl.hidden = true;
      updateFollowButton();
      updateEmptyState();
      sessionId = sid;
      if (info && info.cwd) {
        var parts = info.cwd.split(/[/\\]/);
        repoEl.textContent = parts[parts.length - 1] || info.cwd;
        cachedCwd = info.cwd;
      }
      _drainPendingOpenPath();   // V3.y.1: cwd is now set; deep-link may have queued
      void initFromPersistence(sid);
    });

    var existingId = window.appletAPI.getSessionId && window.appletAPI.getSessionId();
    if (existingId) {
      sessionId = existingId;
      void (async function() {
        try {
          var meta = await window.appletAPI.getSessionMeta(existingId);
          if (meta && meta.cwd) {
            var parts2 = meta.cwd.split(/[/\\]/);
            repoEl.textContent = parts2[parts2.length - 1] || meta.cwd;
            cachedCwd = meta.cwd;
          }
        } catch (_) { /* ignore */ }
        _drainPendingOpenPath();   // V3.y.1: cwd loaded from session meta
        await initFromPersistence(existingId);
      })();
    }
  }

  // Expose pure helpers DiffViewer needs (avoids duplicating into
  // diff-viewer.js). DiffViewer reads via window.__filesApplet._diffHelpers.
  window.__filesApplet._diffHelpers = { fullFileEqual: fullFileEqual };

  updateFollowButton();
  updateEmptyState();
})();
