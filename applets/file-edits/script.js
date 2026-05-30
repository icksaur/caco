/**
 * File Edits applet.
 *
 * Subscribes to caco.edit events from the server-side git-edit-poller and
 * renders collapsible diff cards. See docs/file-edits.md.
 *
 * Layout: stacked cards (newest at top), each header shows chevron + path +
 * time + X. Body (the diff) is hidden by default; clicking the header toggles.
 *
 * v1 behavior: auto-scroll to top on new card insertion. Sticky dismiss
 * (X path is filtered until "Reset dismissals" or applet reopen).
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
      body.innerHTML = renderDiff(edit.diff);
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
        body.innerHTML = renderDiff(card._edit.diff);
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
    if (edit.truncated) {
      var trunc = document.createElement('span');
      trunc.className = 'fe-trunc';
      trunc.title = edit.truncated.hiddenLines + ' lines hidden';
      trunc.textContent = '↘';
      head.insertBefore(trunc, time);
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
        body.innerHTML = renderDiff(newEdit.diff);
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
        // what we already show. Don't touch the DOM (no re-render, no
        // re-insert to top), don't bump time, don't count as applied.
        // This is the load-bearing "don't scroll on idle polls" check.
        var prev = existing._edit;
        if (prev
            && prev.diff === edit.diff
            && prev.status === edit.status
            && prev.renamedFrom === edit.renamedFrom
            && prev.isBinary === edit.isBinary) {
          return;
        }
        existing._renderDiff(edit);
        if (streamEl.firstChild !== existing) {
          streamEl.insertBefore(existing, streamEl.firstChild);
        }
        changedAny = true;
        return;
      }
      var card = makeCard(edit);
      streamEl.insertBefore(card, streamEl.firstChild);
      cards.set(edit.relativePath, card);
      changedAny = true;
    });
    enforceCap();
    updateCounts();
    // v1: scroll-to-top on any REAL change (new card, content update, or clear).
    // No-op polls (same diff bytes for every visible card) don't scroll.
    // v2 evolves to sticky-when-scrolled-away.
    if (changedAny) {
      streamEl.scrollTop = 0;
    }
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
