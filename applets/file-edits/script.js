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
      default: return '?';
    }
  }

  function renderDiff(diff) {
    if (!diff) return '<div class="fe-d-empty">(no diff)</div>';
    var lines = String(diff).split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = 'fe-d-ctx';
      if (line.startsWith('+++') || line.startsWith('---')) cls = 'fe-d-meta';
      else if (line.startsWith('@@')) cls = 'fe-d-hunk';
      else if (line.startsWith('+')) cls = 'fe-d-add';
      else if (line.startsWith('-')) cls = 'fe-d-del';
      else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'fe-d-meta';
      html += '<span class="' + cls + '">' + esc(line) + '</span>\n';
    }
    return html;
  }

  function makeCard(edit) {
    var card = document.createElement('article');
    card.className = 'fe-card';
    card.dataset.path = edit.relativePath;
    card.dataset.expanded = 'false';

    var head = document.createElement('header');
    head.className = 'fe-head';

    var chevron = document.createElement('button');
    chevron.className = 'fe-chevron';
    chevron.type = 'button';
    chevron.setAttribute('aria-label', 'Toggle');
    chevron.textContent = '▶';

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
    body.hidden = true;

    card.appendChild(head);
    card.appendChild(body);

    function toggle() {
      var nowExpanded = card.dataset.expanded !== 'true';
      card.dataset.expanded = nowExpanded ? 'true' : 'false';
      body.hidden = !nowExpanded;
      chevron.textContent = nowExpanded ? '▼' : '▶';
      if (nowExpanded && !body.dataset.rendered) {
        body.innerHTML = renderDiff(edit.diff);
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
    var card = cards.get(path);
    if (card) {
      card.remove();
      cards.delete(path);
    }
    updateCounts();
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
    while (toRemove-- > 0) {
      var path = iter.next().value;
      var c = cards.get(path);
      if (c) c.remove();
      cards.delete(path);
    }
  }

  function applyEdits(edits, cleared) {
    if (Array.isArray(cleared)) {
      cleared.forEach(function(path) {
        var card = cards.get(path);
        if (card) {
          card.remove();
          cards.delete(path);
        }
      });
    }
    if (!Array.isArray(edits)) edits = [];
    var addedAny = false;
    edits.forEach(function(edit) {
      if (!edit || !edit.relativePath) return;
      if (dismissed.has(edit.relativePath)) return;
      var existing = cards.get(edit.relativePath);
      if (existing) {
        existing._renderDiff(edit);
        // Move to top by re-inserting.
        if (streamEl.firstChild !== existing) {
          streamEl.insertBefore(existing, streamEl.firstChild);
        }
        return;
      }
      var card = makeCard(edit);
      // Newest at top.
      streamEl.insertBefore(card, streamEl.firstChild);
      cards.set(edit.relativePath, card);
      addedAny = true;
    });
    enforceCap();
    updateCounts();
    // v1: always scroll to top on insertion (operator preference).
    if (addedAny) {
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
        // Replace current cards with snapshot, preserving dismissed filter.
        streamEl.innerHTML = '';
        cards.clear();
        applyEdits(data.edits, []);
        if (data.edits.length === 0 && cards.size === 0) {
          // could be not-a-git-repo; the server returns [] in both cases.
          // We rely on the first caco.edit broadcast to confirm; v1 keeps
          // it simple and just shows "no changes" until first event.
        }
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
