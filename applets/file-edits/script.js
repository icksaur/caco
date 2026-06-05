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
  /** Map<relativePath, FileTab>. Map iteration order = insertion order =
   *  tab strip order (left-to-right). Tabs never reorder after creation. */
  var tabs = new Map();
  /** Most recent tab to receive a content-changing edit (not no-op). Drives
   *  jumpToMostRecent's primary target. */
  var lastEditedTabId = null;
  /** Distinct paths edited while followEdits was false. Drives Follow
   *  button's N-badge. Cleared on Follow-click and session change. */
  var badgeCounter = new Set();
  /** Single-shot suppression flag for pane scroll. Set by code that does
   *  a programmatic scrollTop write; consumed by the scroll handler. The
   *  hide-swap-show pattern in FileTab.activate prevents spurious scroll
   *  events from the innerHTML clear from burning this flag. */
  /** Value-comparison guard for programmatic scroll writes. The bool
   *  single-shot can be burned by spurious events (visibility flicker,
   *  rAF ordering, double-write from setActiveTab + caller-set-0).
   *  Store the target value the writer asked for; consume only when
   *  the observed scrollTop is within ±1px. Supports any number of
   *  scroll events firing between write and observation. */
  var pendingProgrammaticScroll = null;
  function programmaticScrollTo(target) {
    var maxScroll = Math.max(0, paneEl.scrollHeight - paneEl.clientHeight);
    var clamped = Math.max(0, Math.min(target, maxScroll));
    pendingProgrammaticScroll = { target: clamped };
    paneEl.scrollTop = clamped;
  }
  var sessionId = null;
  var cachedCwd = '';
  var TAB_CAP = 50;

  // ── FileTab class ─────────────────────────────────────────────────────
  function FileTab(edit) {
    this.relativePath = edit.relativePath;
    this.absolutePath = edit.path || '';
    this.edit = edit;
    this.paneEl = null;     // lazy: built on first activate()
    this.scrollTop = 0;
    /** V3.4: per-tab line selection. {start, end} (1-indexed,
     *  inclusive, working-tree line numbers) or null. */
    this.selection = null;
    /** V3.4: pending selection arrived via agent setState before
     *  paneEl was built. Applied on first activate() after render. */
    this.pendingSelection = null;
    this.tabEl = this.buildTabEl();
  }

  FileTab.prototype.buildTabEl = function() {
    var self = this;
    var btn = document.createElement('button');
    btn.className = 'fe-tab';
    btn.type = 'button';
    btn.dataset.path = this.relativePath;
    btn.title = this.relativePath;

    var name = document.createElement('span');
    name.className = 'fe-tab-name';
    name.textContent = basename(this.relativePath);
    btn.appendChild(name);

    var x = document.createElement('span');
    x.className = 'fe-tab-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close tab');
    btn.appendChild(x);

    btn.addEventListener('click', function(e) {
      if (e.target === x || x.contains(e.target)) {
        e.stopPropagation();
        closeTab(self.relativePath);
        return;
      }
      // User clicked the tab: turn off follow, decrement badge for this
      // path (user has now seen it), activate.
      followEdits = false;
      badgeCounter.delete(self.relativePath);
      updateFollowButton();
      setActiveTab(self.relativePath);
    });
    // Middle-click closes the tab (VS Code convention).
    btn.addEventListener('auxclick', function(e) {
      if (e.button !== 1) return;
      e.preventDefault();
      closeTab(self.relativePath);
    });
    // Suppress the middle-mouse autoscroll cursor / paste primary
    // selection so the page doesn't react before auxclick fires.
    btn.addEventListener('mousedown', function(e) {
      if (e.button === 1) e.preventDefault();
    });
    return btn;
  };

  FileTab.prototype.render = function() {
    if (!this.paneEl) this.paneEl = document.createElement('pre');
    this.paneEl.className = 'fe-diff';
    renderBody(this.paneEl, this.edit);
    // pendingSelection is consumed by finalizeAgentSelection (post-render);
    // existing selection is repainted here so updates preserve the highlight.
    this.paintSelection();
  };

  FileTab.prototype.update = function(newEdit) {
    if (this.contentEqual(newEdit)) {
      this.edit = newEdit;
      return false;
    }
    this.edit = newEdit;
    if (this.paneEl) this.render();
    return true;
  };

  FileTab.prototype.contentEqual = function(other) {
    var a = this.edit, b = other;
    return a && b
      && a.diff === b.diff
      && a.status === b.status
      && a.renamedFrom === b.renamedFrom
      && a.isBinary === b.isBinary
      && fullFileEqual(a.fullFile, b.fullFile);
  };

  /** Paint current selection by toggling the .fe-row-selected class
   *  on rows whose data-work-line falls in [start, end]. Clears all
   *  selected classes first. */
  FileTab.prototype.paintSelection = function() {
    if (!this.paneEl) return;
    var existing = this.paneEl.querySelectorAll('.fe-row-selected');
    for (var i = 0; i < existing.length; i++) {
      existing[i].classList.remove('fe-row-selected');
    }
    if (!this.selection) return;
    var rows = this.paneEl.querySelectorAll('.fe-row[data-work-line]');
    for (var j = 0; j < rows.length; j++) {
      var n = parseInt(rows[j].dataset.workLine, 10);
      if (n >= this.selection.start && n <= this.selection.end) {
        rows[j].classList.add('fe-row-selected');
      }
    }
  };

  FileTab.prototype.activate = function() {
    if (!this.paneEl) this.render();
    // Hide-swap-show: visibility:hidden suppresses the innerHTML-clear
    // scroll event. Multiple rapid activate() calls (e.g. init dispatching
    // multiple snapshot edits before the first rAF fires) would otherwise
    // have the second rAF 'restore' to the first's mid-swap 'hidden'
    // state, leaving the pane invisible.
    paneEl.style.visibility = 'hidden';
    paneEl.innerHTML = '';
    paneEl.appendChild(this.paneEl);
    var self = this;
    requestAnimationFrame(function() {
      paneEl.style.visibility = '';
      programmaticScrollTo(self.scrollTop);
    });
  };

  FileTab.prototype.deactivate = function() {
    this.scrollTop = paneEl.scrollTop;
  };

  FileTab.prototype.destroy = function() {
    if (this.tabEl && this.tabEl.parentNode) {
      this.tabEl.parentNode.removeChild(this.tabEl);
    }
    this.paneEl = null;
  };

  function basename(p) {
    var i = p.lastIndexOf('/');
    if (i < 0) i = p.lastIndexOf('\\');
    return i < 0 ? p : p.slice(i + 1);
  }

  // ── V3.4: Selection state + agent / user exchange ────────────────────

  /** Random per-page-load ID. Included in setAppletState broadcasts so
   *  multi-tab cross-echo can be filtered: an applet's own echo arrives
   *  at OTHER tabs but never itself (broadcastToAll excludes sender);
   *  the OTHER tab sees its peer's sourceId and bails to avoid ping-pong.
   *  Agent pushes have no sourceId; never bail. */
  var SOURCE_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'src-' + Math.random().toString(36).slice(2) + '-' + Date.now();

  /** Build the broadcast shape for the agent. Always reflects the
   *  currently-active tab + its selection. */
  function buildFileEditsState() {
    var tab = activeTabId ? tabs.get(activeTabId) : null;
    return {
      activeTab: activeTabId,
      selection: tab && tab.selection ? { start: tab.selection.start, end: tab.selection.end } : null,
      sourceId: SOURCE_ID,
    };
  }

  /** Echo current state to applet-state store (which both this applet
   *  and the agent's get_applet_state read from). Required after every
   *  state-changing user gesture AND after applying an agent push. */
  function echoState() {
    if (!window.appletAPI || !window.appletAPI.setAppletState) return;
    try {
      window.appletAPI.setAppletState({ fileEdits: buildFileEditsState() });
    } catch (err) {
      console.warn('[file-edits] setAppletState failed:', err);
    }
  }

  /** Build the set of valid working-tree line numbers for a tab.
   *  Used to clamp pure-deletion ranges. */
  function workLinesOf(tab) {
    if (!tab || !tab.edit || !tab.edit.fullFile) return null;
    var ff = tab.edit.fullFile;
    if (!Array.isArray(ff.workLines)) return null;
    return ff.workLines.length;
  }

  /** Validate + normalize + clamp an incoming selection per V3.4 §Data
   *  model rules. Returns null if invalid (drop). `validWorkLines` is
   *  the set of line numbers that have a work-side row (excludes
   *  pure-deletion lines). When provided, clamps start UP / end DOWN
   *  to nearest member; if collapsed, returns null. */
  function validateSelection(sel, maxLine, validWorkLines) {
    if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number') return null;
    var a = sel.start, b = sel.end;
    if (maxLine != null) {
      // Bounds-check BEFORE normalization (per spec).
      var aOob = a > maxLine || a < 1;
      var bOob = b > maxLine || b < 1;
      if (aOob && bOob) return null;
      if (aOob) a = Math.max(1, Math.min(a, maxLine));
      if (bOob) b = Math.max(1, Math.min(b, maxLine));
    }
    // Normalize.
    if (a > b) { var t = a; a = b; b = t; }
    // Pure-deletion clamp: start UP to nearest valid work-line >= a,
    // end DOWN to nearest valid work-line <= b. Drop if collapsed.
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

  /** Collect work-line numbers actually rendered in a tab's pane.
   *  Used by validateSelection's clamp step. */
  function renderedWorkLines(tab) {
    if (!tab || !tab.paneEl) return null;
    var rows = tab.paneEl.querySelectorAll('.fe-row[data-work-line]');
    var s = new Set();
    for (var i = 0; i < rows.length; i++) {
      s.add(parseInt(rows[i].dataset.workLine, 10));
    }
    return s;
  }

  /** Scroll the active tab's pane so the selection's first line is at
   *  ~30% from the viewport top. Same recipe as jumpToMostRecent. */
  function scrollPaneToLine(tab, line) {
    if (!tab || !tab.paneEl || tab.paneEl.parentNode !== paneEl) return;
    var row = tab.paneEl.querySelector('.fe-row[data-work-line="' + line + '"]');
    if (!row) return;
    var rowRect = row.getBoundingClientRect();
    var paneRect = paneEl.getBoundingClientRect();
    var offset = rowRect.top - paneRect.top + paneEl.scrollTop;
    var target = Math.max(0, offset - paneEl.clientHeight * 0.3);
    tab.scrollTop = target;
    programmaticScrollTo(target);
  }

  /** User clicked a row. line = data-work-line value. shift = was
   *  shift held. Updates the active tab's selection, repaints, echoes.
   *  Click also turns followEdits off. */
  function userSelectLine(line, shift) {
    var tab = activeTabId ? tabs.get(activeTabId) : null;
    if (!tab) return;
    var max = workLinesOf(tab);
    var valid = renderedWorkLines(tab);
    var newSel;
    if (shift && tab.selection) {
      // Extend existing selection.
      newSel = validateSelection({ start: tab.selection.start, end: line }, max, valid);
    } else {
      newSel = validateSelection({ start: line, end: line }, max, valid);
    }
    tab.selection = newSel;
    tab.paintSelection();
    if (followEdits) {
      followEdits = false;
      updateFollowButton();
    }
    echoState();
  }

  /** User clicked on the pane background (not a row). Clear selection. */
  function userClearSelection() {
    var tab = activeTabId ? tabs.get(activeTabId) : null;
    if (!tab || !tab.selection) return;
    tab.selection = null;
    tab.paintSelection();
    echoState();
  }

  /** Apply agent-pushed state. Opens the tab via POST /open if it
   *  doesn't exist. Selection holds in tab.pendingSelection until the
   *  pane renders. */
  async function applyAgentState(fileEdits) {
    if (!fileEdits || typeof fileEdits !== 'object') return;
    // Multi-tab guard: ignore echoes from our own peer pages.
    if (fileEdits.sourceId === SOURCE_ID) return;
    var targetTabId = fileEdits.activeTab;
    var rawSel = fileEdits.selection || null;

    if (!targetTabId) return;  // we don't auto-clear on agent null activeTab

    var existing = tabs.get(targetTabId);
    if (!existing) {
      // Open via POST /file-edits/open (same as the picker).
      if (!sessionId) return;
      try {
        var res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relativePath: targetTabId }),
        });
        if (!res.ok) {
          console.warn('[file-edits] agent setState: open failed', res.status, targetTabId);
          // Echo back the failure: activeTab unchanged, selection null.
          echoState();
          return;
        }
        var data = await res.json();
        if (!data.edit) {
          echoState();
          return;
        }
        // Stash pending selection BEFORE the openOrUpdateTab call so
        // render() picks it up.
        var newTab = new FileTab(data.edit);
        newTab.pendingSelection = rawSel;  // not validated yet; render-time validation
        if (tabs.size >= TAB_CAP) evictOldestNonActive();
        tabs.set(targetTabId, newTab);
        tabsEl.appendChild(newTab.tabEl);
        // setActiveTab WITHOUT flipping followEdits (agent gesture).
        setActiveTab(targetTabId);
        // After activate's rAF builds the pane, validate the pending
        // selection against the rendered rows and paint.
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            finalizeAgentSelection(newTab);
          });
        });
        schedulePersist();
      } catch (err) {
        console.warn('[file-edits] agent setState: open error', err, targetTabId);
        echoState();
      }
      return;
    }
    // Tab exists. Switch to it (without flipping followEdits) and apply
    // selection.
    if (!existing.paneEl) {
      existing.pendingSelection = rawSel;
    } else {
      existing.pendingSelection = rawSel;
    }
    if (activeTabId !== targetTabId) {
      setActiveTab(targetTabId);
    }
    // Two rAFs to let activate's swap settle.
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        finalizeAgentSelection(existing);
      });
    });
  }

  function finalizeAgentSelection(tab) {
    var raw = tab.pendingSelection;
    tab.pendingSelection = null;
    if (!raw) {
      tab.selection = null;
    } else {
      var max = workLinesOf(tab);
      var valid = renderedWorkLines(tab);
      tab.selection = validateSelection(raw, max, valid);
    }
    tab.paintSelection();
    if (tab.selection) scrollPaneToLine(tab, tab.selection.start);
    echoState();
  }

  // Pane-level click handler: dispatch to row select / background clear.
  paneEl.addEventListener('click', function(e) {
    var row = e.target.closest && e.target.closest('.fe-row[data-work-line]');
    if (row) {
      var n = parseInt(row.dataset.workLine, 10);
      if (!isNaN(n)) userSelectLine(n, !!e.shiftKey);
      return;
    }
    // Click on pane background (not a row) clears selection.
    userClearSelection();
  });

  // Escape clears selection if pane has focus (or anywhere — pane isn't
  // a focusable target, so global is fine here since the applet's only
  // interactive layer is the pane + tab strip + buttons).
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (pickerOpen) return;  // picker handles Escape itself
    var tab = activeTabId ? tabs.get(activeTabId) : null;
    if (tab && tab.selection) {
      e.preventDefault();
      userClearSelection();
    }
  });

  // ── End V3.4 selection ───────────────────────────────────────────────

  // ── Tab orchestration ────────────────────────────────────────────────
  function setActiveTab(tabId) {
    // Note: setActiveTab does NOT modify followEdits. Callers that
    // represent user gestures (tab click, X-on-active, picker selection)
    // must set followEdits=false themselves before calling.
    if (tabId === activeTabId) {
      updateFollowButton();
      schedulePersist();
      return;
    }
    var prev = activeTabId ? tabs.get(activeTabId) : null;
    if (prev) {
      prev.deactivate();
      prev.tabEl.classList.remove('active');
    }
    activeTabId = tabId;
    var next = tabs.get(tabId);
    if (next) {
      next.tabEl.classList.add('active');
      next.activate();
      try {
        next.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      } catch (_) { /* old browsers */ }
    } else {
      // Cleared (no tab active)
      paneEl.innerHTML = '';
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
        if (t) t.destroy();
        tabs.delete(id);
        badgeCounter.delete(id);
        return;
      }
    }
  }

  function openOrUpdateTab(edit, options) {
    options = options || {};
    var id = edit.relativePath;
    if (!id) return;
    var tab = tabs.get(id);
    var isNew = false;
    var contentChanged = false;
    if (!tab) {
      if (tabs.size >= TAB_CAP) evictOldestNonActive();
      tab = new FileTab(edit);
      tabs.set(id, tab);
      tabsEl.appendChild(tab.tabEl);  // append-only, never reorder
      isNew = true;
      contentChanged = true;
    } else {
      contentChanged = tab.update(edit);
      if (!contentChanged && !options.forceFocus) return;
    }
    if (contentChanged) lastEditedTabId = id;

    if (options.forceFocus) {
      // Picker path. Caller already set followEdits=false.
      // Set tab.scrollTop BEFORE setActiveTab so activate()'s rAF
      // restores to 0 — no double-write.
      tab.scrollTop = 0;
      setActiveTab(id);
    } else if (followEdits) {
      if (isNew) tab.scrollTop = 0;
      setActiveTab(id);
    } else {
      // Tab is in the strip but inactive. Bump badge if this is a real edit.
      if (contentChanged) {
        badgeCounter.add(id);
        updateFollowButton();
      }
    }
    updateEmptyState();
    schedulePersist();
  }

  function closeTab(id) {
    var tab = tabs.get(id);
    if (!tab) return;
    var wasActive = id === activeTabId;
    // Compute neighbor BEFORE removing — need pre-removal insertion order.
    var newActive = null;
    if (wasActive) {
      var keys = Array.from(tabs.keys());
      var idx = keys.indexOf(id);
      if (idx > 0) newActive = keys[idx - 1];          // left neighbor
      else if (idx < keys.length - 1) newActive = keys[idx + 1]; // right neighbor
      // else newActive stays null (this was the only tab)
    }
    tab.destroy();
    tabs.delete(id);
    badgeCounter.delete(id);
    if (lastEditedTabId === id) lastEditedTabId = null;
    if (wasActive) {
      activeTabId = null;
      if (newActive) {
        setActiveTab(newActive);
      } else {
        paneEl.innerHTML = '';
        paneEl.appendChild(paneEmptyEl);
        paneEl.appendChild(notGitEl);
      }
    }
    followEdits = false;  // X is a user gesture
    updateFollowButton();
    updateEmptyState();
    schedulePersist();
    echoState();
  }

  function jumpToMostRecent() {
    if (tabs.size === 0) return;
    // Primary: lastEditedTabId. Fallback: highest mtimeMs across all
    // tabs. Final fallback: rightmost (newest in strip order).
    var targetId = null;
    if (lastEditedTabId && tabs.has(lastEditedTabId)) {
      targetId = lastEditedTabId;
    } else {
      var bestMtime = -1;
      tabs.forEach(function(t, id) {
        var m = (t.edit && typeof t.edit.mtimeMs === 'number') ? t.edit.mtimeMs : -1;
        if (m > bestMtime) { bestMtime = m; targetId = id; }
      });
      if (!targetId) {
        var keys = Array.from(tabs.keys());
        targetId = keys[keys.length - 1];
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
    var t = tabs.get(targetId);
    if (!t || !t.paneEl || t.paneEl.parentNode !== paneEl) return;
    var diffRow = t.paneEl.querySelector('.fe-row-add, .fe-row-del');
    if (!diffRow) {
      // No diffs — scroll to top.
      t.scrollTop = 0;
      programmaticScrollTo(0);
      return;
    }
    // Compute target so the diff row sits at ~30% from the top of the
    // visible area (slightly above center reads better than dead center
    // for code).
    var rowRect = diffRow.getBoundingClientRect();
    var paneRect = paneEl.getBoundingClientRect();
    var offsetWithinPane = rowRect.top - paneRect.top + paneEl.scrollTop;
    var target = offsetWithinPane - paneEl.clientHeight * 0.3;
    t.scrollTop = Math.max(0, target);
    programmaticScrollTo(t.scrollTop);
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

  // Pane scroll handler
  paneEl.addEventListener('scroll', function() {
    var st = paneEl.scrollTop;
    // Value-comparison: if scrollTop matches our most recent
    // programmatic-write target (±1px tolerance for sub-pixel rounding),
    // consume the guard and ignore. Tolerant of multiple events firing
    // between write and observation.
    if (pendingProgrammaticScroll && Math.abs(st - pendingProgrammaticScroll.target) <= 1) {
      pendingProgrammaticScroll = null;
      return;
    }
    // Real user scroll: turn off Follow and save the active tab's position.
    pendingProgrammaticScroll = null;
    if (followEdits) {
      followEdits = false;
      updateFollowButton();
    }
    var active = activeTabId ? tabs.get(activeTabId) : null;
    if (active) active.scrollTop = st;
  }, { passive: true });

  // ── Persistence (V2.1 mechanism; tab list reuse cards[]) ─────────────
  var PERSIST_DEBOUNCE_MS = 250;
  var persistTimer = null;
  var persistPendingSid = null;
  var persistPendingBody = null;

  function buildPersistBody() {
    var list = [];
    // Iterate tabs strip in DOM order = insertion order.
    tabs.forEach(function(_t, path) {
      list.push({ relativePath: path, collapsed: false });
    });
    return { schemaVersion: 1, cards: list, dismissed: [] };
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
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        var sel = pickerResults[pickerSelectedIdx];
        if (sel) pickSelected(sel);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      } else if (e.key === 'Backspace' && pickerInput.value === '') {
        e.preventDefault();
        closePicker();
      }
    });
    pickerList.addEventListener('mousedown', function(e) {
      var target = e.target.closest('.fe-picker-item');
      if (!target) return;
      e.preventDefault();
      if (target.classList.contains('disabled')) return;
      var idx = Number(target.dataset.idx);
      var sel = pickerResults[idx];
      if (sel) pickSelected(sel);
    });
  }

  function openPicker() {
    if (!sessionId || pickerOpen) return;
    ensurePickerEl();
    pickerOpen = true;
    pickerEl.hidden = false;
    pickerInput.value = '';
    pickerLastQuery = '';
    pickerSelectedIdx = 0;
    pickerResults = [];
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
  }

  async function runPickerFetch(q) {
    if (!sessionId) return;
    var token = ++pickerFetchToken;
    var url = '/api/project-files?cwd=' + encodeURIComponent(cachedCwd || '');
    if (q) url += '&q=' + encodeURIComponent(q);
    try {
      var res = await fetch(url);
      if (!res.ok) return;
      var data = await res.json();
      if (token !== pickerFetchToken) return;
      pickerResults = (data.files || []).slice(0, PICKER_RESULT_CAP);
      pickerSelectedIdx = 0;
      renderPickerList();
    } catch (_) { /* ignore */ }
  }

  function renderPickerList() {
    if (!pickerList) return;
    pickerList.innerHTML = '';
    for (var i = 0; i < pickerResults.length; i++) {
      var p = pickerResults[i];
      var li = document.createElement('li');
      li.className = 'fe-picker-item';
      li.dataset.idx = String(i);
      if (i === pickerSelectedIdx) li.classList.add('selected');
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
      pickerList.appendChild(li);
    }
  }

  function movePickerSelection(delta) {
    if (pickerResults.length === 0) return;
    pickerSelectedIdx = (pickerSelectedIdx + delta + pickerResults.length) % pickerResults.length;
    var items = pickerList.querySelectorAll('.fe-picker-item');
    items.forEach(function(el, i) { el.classList.toggle('selected', i === pickerSelectedIdx); });
    var sel = items[pickerSelectedIdx];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function pickSelected(relativePath) {
    closePicker();
    void pickFile(relativePath);
  }

  async function pickFile(relativePath) {
    // If already open, just switch and turn off follow.
    if (tabs.has(relativePath)) {
      followEdits = false;
      updateFollowButton();
      setActiveTab(relativePath);
      return;
    }
    if (pickerOpenAbort) pickerOpenAbort.abort();
    pickerOpenAbort = new AbortController();
    var sid = sessionId;
    var edit;
    try {
      var res = await fetch(
        '/api/sessions/' + encodeURIComponent(sid) + '/file-edits/open',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relativePath: relativePath }),
          signal: pickerOpenAbort.signal,
        }
      );
      if (!res.ok) {
        console.warn('[file-edits] open failed', res.status, relativePath);
        return;
      }
      var data = await res.json();
      edit = data.edit;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('[file-edits] open error', err, relativePath);
      return;
    }
    if (sid !== sessionId) return;
    if (!edit) return;
    // User gesture: follow off, then forceFocus open.
    followEdits = false;
    updateFollowButton();
    openOrUpdateTab(edit, { forceFocus: true });
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
      persisted.cards.forEach(function(c) {
        if (!c || !c.relativePath) return;
        if (tabs.has(c.relativePath)) return;
        var placeholder = {
          relativePath: c.relativePath,
          path: '',
          status: 'clean',
          timestamp: new Date().toISOString(),
        };
        var tab = new FileTab(placeholder);
        tabs.set(c.relativePath, tab);
        tabsEl.appendChild(tab.tabEl);
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
      // Tear down in-memory state.
      tabs.forEach(function(t) { t.destroy(); });
      tabs.clear();
      badgeCounter.clear();
      lastEditedTabId = null;
      activeTabId = null;
      followEdits = true;
      cachedCwd = '';
      paneEl.innerHTML = '';
      paneEl.appendChild(paneEmptyEl);
      paneEl.appendChild(notGitEl);
      notGitEl.hidden = true;
      updateFollowButton();
      updateEmptyState();
      sessionId = sid;
      if (info && info.cwd) {
        var parts = info.cwd.split(/[/\\]/);
        repoEl.textContent = parts[parts.length - 1] || info.cwd;
        cachedCwd = info.cwd;
      }
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
        await initFromPersistence(existingId);
      })();
    }
  }

  updateFollowButton();
  updateEmptyState();
})();
