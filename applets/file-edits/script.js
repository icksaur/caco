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
  var resetBtn = document.getElementById('feReset');
  var openBtn = document.getElementById('feOpen');
  var emptyEl = document.getElementById('feEmpty');
  var notGitEl = document.getElementById('feNotGit');
  var streamEl = document.getElementById('feStream');
  var rootEl = streamEl.parentNode;

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
  /** V3.1: cached repo cwd, used by the file picker for fuzzy queries.
   *  Set from info.cwd on session change; from session meta on initial
   *  attach. Cleared on session change before the next session's meta
   *  arrives. */
  var cachedCwd = '';

  // ── V2.1: Persistence ─────────────────────────────────────────────────
  //
  // Per-session card list persisted via /api/sessions/<id>/file-edits/cards.
  // Persisted: card relativePath + collapsed flag + dismissed set.
  // See docs/file-edits-v2.1.md §3.
  var PERSIST_DEBOUNCE_MS = 250;
  var persistTimer = null;
  /** Captured at schedule time so a session switch during the debounce
   *  window flushes the write against the *old* session ID with the
   *  *old* body. Reading DOM/cards/dismissed at flush time would race
   *  with onSessionChange's state clear. */
  var persistPendingSid = null;
  var persistPendingBody = null;

  function buildPersistBody() {
    // Iterate cards in DOM order (insertion order of streamEl.children).
    var list = [];
    var n = streamEl.children;
    for (var i = 0; i < n.length; i++) {
      var c = n[i];
      var p = c.dataset.path;
      if (!p) continue;
      list.push({
        relativePath: p,
        collapsed: userCollapsed.has(p),
      });
    }
    var dis = [];
    dismissed.forEach(function(p) { dis.push(p); });
    return { schemaVersion: 1, cards: list, dismissed: dis };
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

  function schedulePersist() {
    if (!sessionId) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistPendingSid = sessionId;
    // Capture the body NOW. The debounce timer fires later, possibly
    // after onSessionChange has wiped state — but the captured snapshot
    // still reflects the gesture that scheduled it.
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

  /** Synchronous best-effort send via sendBeacon for beforeunload. */
  function flushPersistBeacon() {
    if (!sessionId) return;
    try {
      var body = buildPersistBody();
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      navigator.sendBeacon(
        '/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/cards',
        blob
      );
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
  // ── End persistence ───────────────────────────────────────────────────

  // ── V3.1: File picker ─────────────────────────────────────────────────
  //
  // Fuzzy picker for adding arbitrary repo files as stacked cards. See
  // docs/file-edits-v3.1.md. Bottom of the dependency stack: only depends
  // on sessionId + cachedCwd from outer scope, and applyEdits (defined
  // below).
  var PICKER_FETCH_DEBOUNCE_MS = 100;
  var PICKER_RESULT_CAP = 50;
  var pickerEl = null;          // root <div>; lazily created
  var pickerInput = null;
  var pickerList = null;
  var pickerOpen = false;
  var pickerResults = [];
  var pickerSelectedIdx = 0;
  var pickerLastQuery = '';
  var pickerFetchToken = 0;     // later-query-wins for /project-files
  var pickerFetchTimer = null;
  var pickerOpenAbort = null;   // for the per-pick /file-edits/open call
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
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        movePickerSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        movePickerSelection(-1);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
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
    void runPickerFetch('');  // initial empty-query fetch → alphabetical
    setTimeout(function() { pickerInput.focus(); }, 0);
    // Click-outside dismiss; bind on next tick so this click doesn't
    // immediately re-close it.
    setTimeout(function() {
      pickerOutsideHandler = function(ev) {
        if (!pickerEl.contains(ev.target) && ev.target !== openBtn) {
          closePicker();
        }
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
      if (token !== pickerFetchToken) return;  // later query won
      pickerResults = (data.files || []).slice(0, PICKER_RESULT_CAP);
      pickerSelectedIdx = 0;
      renderPickerList();
    } catch (_) { /* network blip; ignore */ }
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
      if (cards.has(p)) {
        li.classList.add('disabled');
        var sfx = document.createElement('span');
        sfx.className = 'fe-picker-suffix';
        sfx.textContent = '(open)';
        li.appendChild(sfx);
      } else if (dismissed.has(p)) {
        var sfx2 = document.createElement('span');
        sfx2.className = 'fe-picker-suffix';
        sfx2.textContent = '(dismissed)';
        li.appendChild(sfx2);
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
    if (cards.has(relativePath)) return;
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
    if (sid !== sessionId) return;  // session changed mid-fetch
    if (!edit) return;
    dismissed.delete(relativePath);
    applyEdits([edit], [], [], { suppressScroll: true });
  }

  if (openBtn) {
    openBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (pickerOpen) closePicker();
      else openPicker();
    });
  }
  // ── End file picker ───────────────────────────────────────────────────

  // ── Phase 3: Sticky / Autoscroll state machine ─────────────────────────
  //
  // States: 'autoscroll' (default) and 'sticky'. See docs/file-edits-v2.md
  // Phase 3. Cards are never reordered; the state machine only governs
  // scroll-position manipulation.
  /** 'autoscroll' | 'sticky' */
  var scrollMode = 'autoscroll';
  /** When non-null, a programmatic scrollTop write is in flight. The scroll
   *  handler matches event.target.scrollTop to this value (±1px). If it
   *  matches, the flag is consumed and Sticky entry is suppressed. Survives
   *  across rAF boundaries; never pre-cleared synchronously. */
  var pendingProgrammaticScroll = null;
  /** Set<relativePath> tracking files changed during the current Sticky
   *  session. Drives the Follow-edits badge counter. Cleared on Sticky
   *  entry and on Follow-edits click. */
  var stickyChangedPaths = new Set();
  /** The Follow-edits floating button; created lazily on first Sticky entry. */
  var followBtn = null;
  /** Threshold (px) for "scroll to top" → exit Sticky. */
  var TOP_THRESHOLD_PX = 4;

  function enterSticky() {
    if (scrollMode === 'sticky') return;
    scrollMode = 'sticky';
    stickyChangedPaths.clear();
    updateFollowButton();
  }

  function enterAutoscroll() {
    if (scrollMode === 'autoscroll') return;
    scrollMode = 'autoscroll';
    stickyChangedPaths.clear();
    updateFollowButton();
  }

  /** Pick an anchor card for withAnchor's read/write pair. Per spec
   *  §pickAnchor: the first card whose top is at or below the viewport's
   *  top edge; else the last card in the stream; else null. */
  function pickAnchor() {
    var streamRect = streamEl.getBoundingClientRect();
    var children = streamEl.children;
    var lastVisible = null;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      var r = c.getBoundingClientRect();
      var relTop = r.top - streamRect.top;
      if (relTop >= 0) return c;
      lastVisible = c;
    }
    return lastVisible;
  }

  /** Run `fn` and, if we're in Sticky, preserve the visual position of
   *  the anchor card across the mutation. The flag `pendingProgrammaticScroll`
   *  is set if a compensating scrollTop write happens; the scroll handler
   *  consumes it. */
  /** Set streamEl.scrollTop and arm the programmatic-scroll flag with
   *  the value the browser will actually settle on (clamped to
   *  [0, scrollHeight - clientHeight]). Without clamping, the browser
   *  clamps silently and the scroll handler sees scrollTop != target,
   *  misclassifying our own write as a user scroll. */
  function programmaticScrollTo(target) {
    var maxScroll = Math.max(0, streamEl.scrollHeight - streamEl.clientHeight);
    var clamped = Math.max(0, Math.min(target, maxScroll));
    pendingProgrammaticScroll = { target: clamped };
    streamEl.scrollTop = clamped;
  }

  function withAnchor(fn) {
    if (scrollMode !== 'sticky') { fn(); return; }
    requestAnimationFrame(function() {
      var anchor = pickAnchor();
      var beforeTop = anchor ? anchor.getBoundingClientRect().top : 0;
      fn();
      var afterTop = anchor && document.contains(anchor)
        ? anchor.getBoundingClientRect().top
        : null;
      if (afterTop !== null && afterTop !== beforeTop) {
        programmaticScrollTo(streamEl.scrollTop + (afterTop - beforeTop));
      }
    });
  }

  /** Scroll handler. Distinguishes programmatic from user scrolls by
   *  matching scrollTop against pendingProgrammaticScroll.target (±1px). */
  function onStreamScroll() {
    var st = streamEl.scrollTop;
    if (pendingProgrammaticScroll && Math.abs(st - pendingProgrammaticScroll.target) <= 1) {
      pendingProgrammaticScroll = null;
      return;
    }
    pendingProgrammaticScroll = null;
    // Real user scroll. Decide state.
    if (st < TOP_THRESHOLD_PX) {
      enterAutoscroll();
      return;
    }
    if (streamEl.scrollHeight <= streamEl.clientHeight) {
      enterAutoscroll();
      return;
    }
    enterSticky();
  }

  /** Instant scroll to put `card` at top of stream viewport. No-op if
   *  the card is fully visible (`force=false`, the autoscroll-on-edit
   *  default). When `force=true` (Follow-edits click), always scroll
   *  even if the target is already visible — the user explicitly asked
   *  to be taken there and a silent no-op makes the button look broken. */
  function scrollToCard(card, force) {
    if (!card) return;
    var cr = card.getBoundingClientRect();
    var sr = streamEl.getBoundingClientRect();
    if (!force) {
      var fullyVisible = cr.top >= sr.top && cr.bottom <= sr.bottom;
      if (fullyVisible) return;
    }
    programmaticScrollTo(streamEl.scrollTop + (cr.top - sr.top));
  }

  /** Lazily create the Follow-edits button and bind to the stream's
   *  parent so it floats over the scroll container. */
  function ensureFollowButton() {
    if (followBtn) return followBtn;
    followBtn = document.createElement('button');
    followBtn.className = 'fe-follow';
    followBtn.type = 'button';
    followBtn.hidden = true;
    followBtn.addEventListener('click', function() {
      // Scroll to the topmost-in-DOM card affected this session, then
      // exit sticky. Never reorder.
      var target = null;
      streamChildren().some(function(c) {
        if (stickyChangedPaths.has(c.dataset.path)) { target = c; return true; }
        return false;
      });
      enterAutoscroll();
      if (target) {
        scrollToCard(target, true);
      } else {
        // No identified changed card — scroll to bottom of stream
        // (most recently created cards live there).
        programmaticScrollTo(streamEl.scrollHeight - streamEl.clientHeight);
      }
    });
    // Insert as sibling of streamEl inside the same offset parent.
    streamEl.parentNode.insertBefore(followBtn, streamEl.nextSibling);
    return followBtn;
  }

  function streamChildren() {
    var out = [];
    var n = streamEl.children;
    for (var i = 0; i < n.length; i++) out.push(n[i]);
    return out;
  }

  function updateFollowButton() {
    if (scrollMode !== 'sticky') {
      if (followBtn) followBtn.hidden = true;
      return;
    }
    var btn = ensureFollowButton();
    btn.hidden = false;
    var n = stickyChangedPaths.size;
    btn.textContent = n > 0
      ? ('↓ ' + n + ' new edit' + (n === 1 ? '' : 's'))
      : '↓ Follow edits';
  }

  // ── End Phase 3 state machine ─────────────────────────────────────────

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
    // Compute per-row word marks from the raw rows so adjacent del/add
    // pairs are paired correctly.
    var marks = computeAllWordMarks(rawRows);
    marks.forEach(function(m, idx) { rawRows[idx].mark = m; });
    // V2.1: never fold. Always render the entire file. Operator gesture:
    // "always show entire file, no folding, even if no diffs."
    var rows = rawRows;
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

    // V3 MVP: open in external editor (vscode://). Absolute `path` is
    // set by the server; if the path is missing we omit the link rather
    // than fabricate one.
    var openBtn = null;
    if (edit.path) {
      openBtn = document.createElement('a');
      openBtn.className = 'fe-open';
      openBtn.href = 'vscode://file/' + encodeURI(edit.path).replace(/#/g, '%23');
      openBtn.title = 'Open in VS Code';
      openBtn.setAttribute('aria-label', 'Open in editor');
      openBtn.textContent = '↗';
      // Prevent the header click (which toggles collapse) from firing
      // when the user clicks the link.
      openBtn.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    var xBtn = document.createElement('button');
    xBtn.className = 'fe-x';
    xBtn.type = 'button';
    xBtn.setAttribute('aria-label', 'Dismiss');
    xBtn.textContent = '×';

    head.appendChild(chevron);
    head.appendChild(status);
    head.appendChild(path);
    if (openBtn) head.appendChild(openBtn);
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
      enterSticky();
      withAnchor(function() {
        var nowExpanded = card.dataset.expanded !== 'true';
        card.dataset.expanded = nowExpanded ? 'true' : 'false';
        body.hidden = !nowExpanded;
        chevron.textContent = nowExpanded ? '▼' : '▶';
        if (nowExpanded) userCollapsed.delete(edit.relativePath);
        else userCollapsed.add(edit.relativePath);
        if (nowExpanded && !body.dataset.rendered) {
          renderBody(body, card._edit);
          body.dataset.rendered = '1';
        }
        schedulePersist();
      });
    }

    chevron.addEventListener('click', function(e) { e.stopPropagation(); toggle(); });
    head.addEventListener('click', function(e) {
      if (e.target === xBtn || xBtn.contains(e.target)) return;
      toggle();
    });
    xBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      enterSticky();
      withAnchor(function() { dismissPath(edit.relativePath); });
    });

    if (edit.isBinary) {
      chevron.disabled = true;
      chevron.title = 'binary file';
      body.hidden = true;
      var binNote = document.createElement('span');
      binNote.className = 'fe-binary';
      binNote.textContent = '(binary)';
      head.insertBefore(binNote, xBtn);
    }
    if (edit.truncated && !edit.fullFile) {
      var trunc = document.createElement('span');
      trunc.className = 'fe-trunc';
      trunc.title = edit.truncated.hiddenLines + ' lines hidden';
      trunc.textContent = '↘';
      head.insertBefore(trunc, xBtn);
    }
    if (!edit.fullFile && !edit.isBinary && edit.status !== 'clean') {
      var fb = document.createElement('span');
      fb.className = 'fe-fallback';
      fb.title = 'Showing hunk-only view (file too large, deleted, or fallback)';
      fb.textContent = 'hunk view';
      head.insertBefore(fb, xBtn);
    }

    card._edit = edit;
    card._renderDiff = function(newEdit) {
      card._edit = newEdit;
      card.dataset.status = newEdit.status || 'modified';
      path.textContent = newEdit.renamedFrom
        ? (newEdit.renamedFrom + ' → ' + newEdit.relativePath)
        : newEdit.relativePath;
      status.className = 'fe-status fe-s-' + (newEdit.status || 'modified');
      status.textContent = statusLabel(newEdit.status);
      // V3 MVP: keep the open-in-editor link in sync. The link may not
      // exist on the placeholder created without an absolute path; in
      // that case lazily insert it the first time we get a real path.
      if (newEdit.path) {
        var href = 'vscode://file/' + encodeURI(newEdit.path).replace(/#/g, '%23');
        if (openBtn) {
          openBtn.href = href;
        } else {
          openBtn = document.createElement('a');
          openBtn.className = 'fe-open';
          openBtn.href = href;
          openBtn.title = 'Open in VS Code';
          openBtn.setAttribute('aria-label', 'Open in editor');
          openBtn.textContent = '↗';
          openBtn.addEventListener('click', function(e) { e.stopPropagation(); });
          head.insertBefore(openBtn, xBtn);
        }
      }
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
    schedulePersist();
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
   *  user can dismiss on their own schedule.
   *
   *  V2.1: when `entry` is provided (from the server's cleanedEdits array),
   *  the card body fills in with the full HEAD content. When called with
   *  path only (legacy cleared-path path), the body is empty pending a
   *  subsequent cleanedEdits arrival. The idempotency guard prevents
   *  redundant re-render when content is unchanged. */
  function markClean(path, entry) {
    var card = cards.get(path);
    if (!card) return;
    var prev = card._edit || {};
    // V2.1: if an entry with fullFile is provided and matches what we
    // already render, no-op. fullFileEqual is defined later in the file.
    if (entry && prev.status === 'clean'
        && fullFileEqual(prev.fullFile, entry.fullFile)) {
      return;
    }
    if (!entry && prev.status === 'clean' && !prev.diff && !prev.fullFile) {
      return;
    }
    var nextEdit = entry || {
      relativePath: path,
      status: 'clean',
      diff: '',
      timestamp: new Date().toISOString(),
      isBinary: false,
      renamedFrom: null,
    };
    card._renderDiff(nextEdit);
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
    // V2.1: evict oldest CLEAN cards first; only fall back to oldest
    // dirty cards if we still exceed the cap after exhausting clean.
    // Cards Map iteration order is insertion order; oldest first.
    var toRemove = cards.size - VISIBLE_CAP;
    var cleanPaths = [];
    var dirtyPaths = [];
    cards.forEach(function(card, path) {
      var st = card.dataset.status;
      if (st === 'clean') cleanPaths.push(path);
      else dirtyPaths.push(path);
    });
    var paths = [];
    for (var i = 0; i < cleanPaths.length && paths.length < toRemove; i++) {
      paths.push(cleanPaths[i]);
    }
    for (var j = 0; j < dirtyPaths.length && paths.length < toRemove; j++) {
      paths.push(dirtyPaths[j]);
    }
    paths.forEach(removeCard);
    if (paths.length > 0) schedulePersist();
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

  function applyEdits(edits, cleared, cleanedEdits, options) {
    options = options || {};
    // Collect the actual mutations as closures so we can run them all
    // inside one withAnchor (rAF) when in Sticky, and identify the
    // topmost changed card for autoscroll otherwise.
    var mutations = [];
    var topmostChangedCard = null;
    /** Track the relativePath of every file actually changed by this
     *  apply (new card or in-place update or clean). Used by the
     *  Follow-edits badge counter. */
    var changedPathsThisApply = [];
    /** V2.1: paths covered by cleanedEdits should not also be processed
     *  from `cleared` (which would emit a content-less markClean and
     *  trip the idempotency guard). */
    var cleanedPathsSeen = new Set();

    if (Array.isArray(cleanedEdits)) {
      cleanedEdits.forEach(function(entry) {
        if (!entry || !entry.relativePath) return;
        var p = entry.relativePath;
        cleanedPathsSeen.add(p);
        if (cards.has(p)) {
          mutations.push(function() { markClean(p, entry); });
          changedPathsThisApply.push(p);
          if (!topmostChangedCard) topmostChangedCard = cards.get(p);
        } else if (!dismissed.has(p)) {
          // The path is in cleanedEdits but no card exists locally yet
          // (e.g. snapshot raced with poll). Spawn a clean card.
          mutations.push(function() {
            var card = makeCard(entry);
            streamEl.appendChild(card);
            cards.set(p, card);
            if (!topmostChangedCard) topmostChangedCard = card;
          });
          changedPathsThisApply.push(p);
        }
      });
    }

    if (Array.isArray(cleared)) {
      cleared.forEach(function(p) {
        if (cleanedPathsSeen.has(p)) return;
        if (cards.has(p)) {
          mutations.push(function() { markClean(p); });
          changedPathsThisApply.push(p);
          if (!topmostChangedCard) topmostChangedCard = cards.get(p);
        }
      });
    }
    if (!Array.isArray(edits)) edits = [];
    edits.forEach(function(edit) {
      if (!edit || !edit.relativePath) return;
      if (dismissed.has(edit.relativePath)) return;
      var existing = cards.get(edit.relativePath);
      if (existing) {
        // No-op poll: server re-broadcast an entry that's byte-identical
        // to what we already show. Don't touch the DOM. Load-bearing for
        // "don't disturb the user on idle polls."
        var prev = existing._edit;
        if (prev
            && prev.diff === edit.diff
            && prev.status === edit.status
            && prev.renamedFrom === edit.renamedFrom
            && prev.isBinary === edit.isBinary
            && fullFileEqual(prev.fullFile, edit.fullFile)) {
          return;
        }
        mutations.push(function() { existing._renderDiff(edit); });
        changedPathsThisApply.push(edit.relativePath);
        if (!topmostChangedCard || compareDomOrder(existing, topmostChangedCard) < 0) {
          topmostChangedCard = existing;
        }
        return;
      }
      // New card: append to bottom. Cards are never reordered.
      mutations.push(function() {
        var card = makeCard(edit);
        streamEl.appendChild(card);
        cards.set(edit.relativePath, card);
        if (!topmostChangedCard) topmostChangedCard = card;
      });
      changedPathsThisApply.push(edit.relativePath);
    });

    if (mutations.length === 0) return;

    function applyAll() {
      var beforePaths = [];
      var c = streamEl.children;
      for (var k = 0; k < c.length; k++) beforePaths.push(c[k].dataset.path || '');
      for (var i = 0; i < mutations.length; i++) mutations[i]();
      enforceCap();
      updateCounts();
      // V2.1: only persist when the visible card set (paths in DOM order)
      // actually changed. Avoids noisy PUTs on every poll that just
      // re-renders the same card.
      var afterPaths = [];
      var c2 = streamEl.children;
      for (var m = 0; m < c2.length; m++) afterPaths.push(c2[m].dataset.path || '');
      if (beforePaths.length !== afterPaths.length
          || beforePaths.some(function(p, idx) { return p !== afterPaths[idx]; })) {
        schedulePersist();
      }
    }

    if (scrollMode === 'sticky') {
      withAnchor(applyAll);
      changedPathsThisApply.forEach(function(p) { stickyChangedPaths.add(p); });
      updateFollowButton();
    } else {
      applyAll();
      if (topmostChangedCard && !options.suppressScroll) scrollToCard(topmostChangedCard);
    }
  }

  /** Compare two cards by DOM order: returns <0 if `a` precedes `b`,
   *  0 if same, >0 if `a` follows `b`. */
  function compareDomOrder(a, b) {
    if (a === b) return 0;
    var pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    return 1;
  }

  /** V2.1: load persisted cards + dismissed, then fetch snapshot. Initial
   *  card creation order = persisted order. The snapshot's clean entries
   *  fill in bodies for persisted-clean paths automatically (server now
   *  includes them in /snapshot). Any snapshot path NOT in persisted is
   *  appended at the end. */
  async function initFromPersistence(sid) {
    var persisted = await loadPersistedCards(sid);
    if (persisted && Array.isArray(persisted.dismissed)) {
      persisted.dismissed.forEach(function(p) { dismissed.add(p); });
    }
    var collapsedSet = new Set();
    var persistedOrder = [];
    if (persisted && Array.isArray(persisted.cards)) {
      persisted.cards.forEach(function(c) {
        if (!c || !c.relativePath) return;
        if (dismissed.has(c.relativePath)) return;
        persistedOrder.push(c.relativePath);
        if (c.collapsed) collapsedSet.add(c.relativePath);
      });
    }
    // Seed userCollapsed so makeCard sees the persisted collapse state
    // when each card is created in the snapshot pass.
    collapsedSet.forEach(function(p) { userCollapsed.add(p); });
    // Pre-seed empty cards for persisted-but-not-in-snapshot paths so
    // they appear in the right order even before the snapshot resolves.
    // makeCard requires an `edit`; synthesize a minimal clean placeholder.
    persistedOrder.forEach(function(p) {
      if (cards.has(p)) return;
      var placeholder = {
        relativePath: p,
        status: 'clean',
        timestamp: new Date().toISOString(),
      };
      var card = makeCard(placeholder);
      streamEl.appendChild(card);
      cards.set(p, card);
    });
    updateCounts();
    await fetchSnapshot();
  }

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

  resetBtn.addEventListener('click', function() {
    dismissed.clear();
    schedulePersist();
    void fetchSnapshot();
  });

  // Wire to session events.
  if (window.appletAPI) {
    window.appletAPI.onSessionEvent(function(event) {
      if (event && event.type === 'caco.edit' && event.data) {
        applyEdits(event.data.edits, event.data.cleared, event.data.cleanedEdits);
      }
    });
    window.appletAPI.onSessionChange(function(sid, info) {
      // V2.1: flush pending PUT for the OUTGOING session before tearing
      // down state. Without this, a dismiss/collapse within 250ms of
      // session-switch is lost.
      flushPersist();
      // V3.1: close the picker and cancel any in-flight /open call
      // against the outgoing session.
      closePicker();
      if (pickerOpenAbort) { pickerOpenAbort.abort(); pickerOpenAbort = null; }
      cachedCwd = '';
      sessionId = sid;
      if (info && info.cwd) {
        var parts = info.cwd.split(/[/\\]/);
        repoEl.textContent = parts[parts.length - 1] || info.cwd;
        cachedCwd = info.cwd;
      }
      streamEl.innerHTML = '';
      cards.clear();
      dismissed.clear();
      userCollapsed.clear();
      enterAutoscroll();
      updateCounts();
      void initFromPersistence(sid);
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
            cachedCwd = meta.cwd;
          }
        } catch (_) { /* ignore */ }
        await initFromPersistence(existingId);
      })();
    }
  }

  updateCounts();
  streamEl.addEventListener('scroll', onStreamScroll, { passive: true });
})();
