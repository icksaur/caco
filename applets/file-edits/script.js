/**
 * File Edits applet.
 *
 * Subscribes to caco.edit events from the server-side git-edit-poller and
 * renders collapsible diff cards. See docs/file-edits.md and
 * docs/file-edits-v2.md.
 *
 * Layout: stacked cards (first-touched at top — never reordered), each
 * header shows chevron + path + time + X. Body (the diff) is expanded by
 * default; clicking the header toggles.
 *
 * V1 behavior (current): cards are never reordered after creation; new
 * cards append to the bottom of the stream. No autoscroll — user controls
 * scroll. V2 Phase 3 adds a sticky/autoscroll state machine.
 *
 * Sticky dismiss: X path is filtered until "Reset dismissals" or applet
 * reopen.
 */

(function() {
  var repoEl = document.getElementById('feRepo');
  var countsEl = document.getElementById('feCounts');
  var refreshBtn = document.getElementById('feRefresh');
  var resetBtn = document.getElementById('feReset');
  var emptyEl = document.getElementById('feEmpty');
  var notGitEl = document.getElementById('feNotGit');
  var streamEl = document.getElementById('feStream');

  /** Map<relativePath, HTMLElement>. */
  var cards = new Map();
  /** Set<relativePath>. Sticky until reset. */
  var dismissed = new Set();
  /** Set<relativePath>. Paths the user explicitly collapsed; sticky for the
   *  life of the card. Cleared when the card is removed (e.g. file returns
   *  to HEAD, then comes back: defaults to expanded again). */
  var userCollapsed = new Set();
  var VISIBLE_CAP = 50;
  var sessionId = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 1) return 'now';
    if (diff < 60) return Math.round(diff) + 's';
    if (diff < 3600) return Math.round(diff / 60) + 'm';
    if (diff < 86400) return Math.round(diff / 3600) + 'h';
    return Math.round(diff / 86400) + 'd';
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
   *  highlighting (silent fallback). */
  var EXT_TO_LANG = {
    'ts': 'typescript', 'tsx': 'typescript',
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'py': 'python',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
    'md': 'markdown', 'markdown': 'markdown',
    'json': 'json',
    'html': 'html', 'htm': 'html', 'xml': 'xml',
    'css': 'css', 'scss': 'scss',
    'rs': 'rust',
    'go': 'go',
    'yml': 'yaml', 'yaml': 'yaml',
    'toml': 'ini',
    'sql': 'sql',
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

  /** Build a single non-fold row element. */
  function buildRowEl(row, lang) {
    var div = document.createElement('div');
    div.className = 'fe-row fe-row-' + row.kind;
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
      var el = buildRowEl(row.hidden[i], lang);
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
    var rows = collapseFolds(buildRows(ff.headLines, ff.workLines, ff.hunks || []));
    if (rows.length === 0) {
      body.innerHTML = '<div class="fe-d-empty">(no visible changes)</div>';
      return true;
    }
    var lang = detectLanguage(edit.relativePath);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      frag.appendChild(r.kind === 'fold' ? buildFoldEl(r, lang) : buildRowEl(r, lang));
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

  function makeCard(edit) {
    var startCollapsed = userCollapsed.has(edit.relativePath);
    var card = document.createElement('article');
    card.className = 'fe-card';
    card.dataset.path = edit.relativePath;
    card.dataset.expanded = startCollapsed ? 'false' : 'true';
    card.dataset.status = edit.status || 'modified';

    var head = document.createElement('header');
    head.className = 'fe-head';

    var chevron = document.createElement('button');
    chevron.className = 'fe-chevron';
    chevron.type = 'button';
    chevron.setAttribute('aria-label', 'Toggle');
    chevron.textContent = startCollapsed ? '▶' : '▼';

    var status = document.createElement('span');
    status.className = 'fe-status fe-s-' + (edit.status || 'modified');
    status.textContent = statusLabel(edit.status);

    var path = document.createElement('code');
    path.className = 'fe-path';
    path.textContent = edit.renamedFrom
      ? (edit.renamedFrom + ' → ' + edit.relativePath)
      : edit.relativePath;

    var time = document.createElement('time');
    time.className = 'fe-time';
    time.dataset.iso = edit.timestamp;
    time.textContent = timeAgo(edit.timestamp);

    var xBtn = document.createElement('button');
    xBtn.className = 'fe-x';
    xBtn.type = 'button';
    xBtn.setAttribute('aria-label', 'Dismiss');
    xBtn.textContent = '×';

    head.appendChild(chevron);
    head.appendChild(status);
    head.appendChild(path);
    head.appendChild(time);
    head.appendChild(xBtn);

    var body = document.createElement('pre');
    body.className = 'fe-diff';
    body.hidden = startCollapsed;

    card.appendChild(head);
    card.appendChild(body);

    // If we start expanded, render the diff body now.
    if (!startCollapsed) {
      renderBody(body, edit);
      body.dataset.rendered = '1';
    }

    function toggle() {
      var nowExpanded = card.dataset.expanded !== 'true';
      card.dataset.expanded = nowExpanded ? 'true' : 'false';
      body.hidden = !nowExpanded;
      chevron.textContent = nowExpanded ? '▼' : '▶';
      // Track explicit user collapse so subsequent updates respect it.
      if (nowExpanded) userCollapsed.delete(edit.relativePath);
      else userCollapsed.add(edit.relativePath);
      if (nowExpanded && !body.dataset.rendered) {
        renderBody(body, card._edit);
        body.dataset.rendered = '1';
      }
    }

    chevron.addEventListener('click', function(e) { e.stopPropagation(); toggle(); });
    head.addEventListener('click', function(e) {
      if (e.target === xBtn || xBtn.contains(e.target)) return;
      toggle();
    });
    xBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      dismissPath(edit.relativePath);
    });

    if (edit.isBinary) {
      chevron.disabled = true;
      chevron.title = 'binary file';
      body.hidden = true;
      var binNote = document.createElement('span');
      binNote.className = 'fe-binary';
      binNote.textContent = '(binary)';
      head.insertBefore(binNote, time);
    }
    if (edit.truncated && !edit.fullFile) {
      var trunc = document.createElement('span');
      trunc.className = 'fe-trunc';
      trunc.title = edit.truncated.hiddenLines + ' lines hidden';
      trunc.textContent = '↘';
      head.insertBefore(trunc, time);
    }
    if (!edit.fullFile && !edit.isBinary && edit.status !== 'clean') {
      var fb = document.createElement('span');
      fb.className = 'fe-fallback';
      fb.title = 'Showing hunk-only view (file too large, deleted, or fallback)';
      fb.textContent = 'hunk view';
      head.insertBefore(fb, time);
    }

    card._edit = edit;
    card._renderDiff = function(newEdit) {
      card._edit = newEdit;
      card.dataset.status = newEdit.status || 'modified';
      time.dataset.iso = newEdit.timestamp;
      time.textContent = timeAgo(newEdit.timestamp);
      path.textContent = newEdit.renamedFrom
        ? (newEdit.renamedFrom + ' → ' + newEdit.relativePath)
        : newEdit.relativePath;
      status.className = 'fe-status fe-s-' + (newEdit.status || 'modified');
      status.textContent = statusLabel(newEdit.status);
      // If body is currently expanded, re-render the diff to reflect the new content.
      if (card.dataset.expanded === 'true') {
        renderBody(body, newEdit);
        body.dataset.rendered = '1';
      } else {
        // Drop the rendered flag so next expand pulls fresh.
        delete body.dataset.rendered;
      }
    };
    return card;
  }

  function dismissPath(path) {
    dismissed.add(path);
    removeCard(path);
    updateCounts();
  }

  /** Remove a card from the DOM and forget its user-collapse state.
   *  Only called by user dismiss (X) and cap eviction — never by poller-driven
   *  "file went clean". Clean files keep their card; see markClean. */
  function removeCard(path) {
    var card = cards.get(path);
    if (card) {
      card.remove();
      cards.delete(path);
    }
    userCollapsed.delete(path);
  }

  /** Mark a card as clean (file no longer in dirty set). Keeps the card so the
   *  user can dismiss on their own schedule; just shows an empty body and a
   *  muted status pill. */
  function markClean(path) {
    var card = cards.get(path);
    if (!card) return;
    var prev = card._edit || {};
    if (prev.status === 'clean' && !prev.diff) return;
    card._renderDiff({
      relativePath: path,
      status: 'clean',
      diff: '',
      timestamp: new Date().toISOString(),
      isBinary: false,
      renamedFrom: null,
    });
  }

  function updateCounts() {
    var visible = cards.size;
    var dCount = dismissed.size;
    if (visible === 0 && dCount === 0) {
      countsEl.textContent = 'no changes';
    } else {
      var parts = [];
      parts.push(visible + ' file' + (visible === 1 ? '' : 's'));
      if (dCount > 0) parts.push(dCount + ' dismissed');
      countsEl.textContent = parts.join(' · ');
    }
    emptyEl.hidden = visible > 0 || notGitEl.hidden === false;
    resetBtn.hidden = dCount === 0;
  }

  function enforceCap() {
    if (cards.size <= VISIBLE_CAP) return;
    // Drop oldest: cards Map iteration order is insertion order; oldest first.
    var toRemove = cards.size - VISIBLE_CAP;
    var iter = cards.keys();
    var paths = [];
    while (toRemove-- > 0) {
      paths.push(iter.next().value);
    }
    paths.forEach(removeCard);
  }

  /** Cheap deep-equality for fullFile payloads, used by the no-op poll
   *  guard. Compares hunk metadata and stringified line arrays. Returns
   *  true if both sides are absent or both are present and equal. */
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

  function applyEdits(edits, cleared) {
    var changedAny = false;
    if (Array.isArray(cleared)) {
      cleared.forEach(function(p) {
        if (cards.has(p)) { markClean(p); changedAny = true; }
      });
    }
    if (!Array.isArray(edits)) edits = [];
    edits.forEach(function(edit) {
      if (!edit || !edit.relativePath) return;
      if (dismissed.has(edit.relativePath)) return;
      var existing = cards.get(edit.relativePath);
      if (existing) {
        // No-op poll: server re-broadcast an entry that's byte-identical to
        // what we already show. Don't touch the DOM, don't bump time, don't
        // count as applied. Load-bearing for "don't disturb the user on
        // idle polls."
        var prev = existing._edit;
        if (prev
            && prev.diff === edit.diff
            && prev.status === edit.status
            && prev.renamedFrom === edit.renamedFrom
            && prev.isBinary === edit.isBinary
            && fullFileEqual(prev.fullFile, edit.fullFile)) {
          return;
        }
        // Re-render in place. Never reorder; the card's DOM position is
        // fixed for its lifetime. (V2 Phase 3 will add autoscroll-to-card
        // when the changed card is off-screen.)
        existing._renderDiff(edit);
        changedAny = true;
        return;
      }
      // New card: append to bottom. Cards are never reordered (V2 Phase 3
      // decision applied retroactively to V1). Stream is a stable timeline,
      // first-touched-first, top-to-bottom.
      var card = makeCard(edit);
      streamEl.appendChild(card);
      cards.set(edit.relativePath, card);
      changedAny = true;
    });
    enforceCap();
    updateCounts();
    // V1 used to scrollTop = 0 here. Removed: with append-at-bottom there is
    // no top-of-stream affordance, and auto-scrolling on every change
    // disturbs the user reading older context. V2 Phase 3 will reintroduce
    // a sticky/autoscroll state machine that scrolls to the changed card
    // only when the user has not scrolled away.
  }

  function tickTimestamps() {
    cards.forEach(function(card) {
      var t = card.querySelector('.fe-time');
      if (t && t.dataset.iso) t.textContent = timeAgo(t.dataset.iso);
    });
  }
  setInterval(tickTimestamps, 5000);

  async function fetchSnapshot() {
    if (!sessionId) return;
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/snapshot');
      if (!res.ok) {
        if (res.status === 404) {
          // Session gone — show neutral.
          notGitEl.hidden = true;
          emptyEl.hidden = false;
          return;
        }
        return;
      }
      var data = await res.json();
      if (Array.isArray(data.edits)) {
        // Merge: cards persist across snapshots. Anything currently shown
        // that isn't in the snapshot becomes "clean" (file went back to
        // HEAD); only user X or cap eviction actually removes a card.
        var seen = new Set();
        data.edits.forEach(function(e) { if (e && e.relativePath) seen.add(e.relativePath); });
        var cleared = [];
        cards.forEach(function(_card, path) {
          if (!seen.has(path)) cleared.push(path);
        });
        applyEdits(data.edits, cleared);
      }
    } catch (err) {
      console.warn('[file-edits] snapshot failed:', err);
    }
  }

  refreshBtn.addEventListener('click', async function() {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('fe-spin');
    try {
      if (sessionId) {
        await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/refresh', { method: 'POST' });
      }
      await fetchSnapshot();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('fe-spin');
    }
  });

  resetBtn.addEventListener('click', function() {
    dismissed.clear();
    void fetchSnapshot();
  });

  // Wire to session events.
  if (window.appletAPI) {
    window.appletAPI.onSessionEvent(function(event) {
      if (event && event.type === 'caco.edit' && event.data) {
        applyEdits(event.data.edits, event.data.cleared);
      }
    });
    window.appletAPI.onSessionChange(function(sid, info) {
      sessionId = sid;
      if (info && info.cwd) {
        var parts = info.cwd.split(/[/\\]/);
        repoEl.textContent = parts[parts.length - 1] || info.cwd;
      }
      streamEl.innerHTML = '';
      cards.clear();
      dismissed.clear();
      userCollapsed.clear();
      updateCounts();
      void fetchSnapshot();
    });
    // If session was already active when applet opened, kick a snapshot now.
    var existingId = window.appletAPI.getSessionId && window.appletAPI.getSessionId();
    if (existingId) {
      sessionId = existingId;
      void (async function() {
        try {
          var meta = await window.appletAPI.getSessionMeta(existingId);
          if (meta && meta.cwd) {
            var parts2 = meta.cwd.split(/[/\\]/);
            repoEl.textContent = parts2[parts2.length - 1] || meta.cwd;
          }
        } catch (_) { /* ignore */ }
        await fetchSnapshot();
      })();
    }
  }

  updateCounts();
})();
