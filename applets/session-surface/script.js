// session-surface — V1 roadmap-style applet.
// Reads /api/sessions/:id/surface, renders status badges, lets the user
// cycle status, PUTs to /surface/changes/:itemId.
// Timing note: do not call window.appletAPI at the top level of this IIFE —
// it may not be wired yet. Access it inside async callbacks instead.

var statusOrder = ['pending', 'active', 'done', 'blocked'];

function nextStatus(s) {
  var i = statusOrder.indexOf(s);
  return statusOrder[(i + 1) % statusOrder.length];
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitize(html) {
  var purify = window.DOMPurify;
  if (!purify) return esc(html);
  return purify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'p', 'br', 'span', 'strong', 'em', 'code', 'pre', 'kbd', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/)/i,
  });
}

var doc = null;
var pendingPuts = Promise.resolve();
var hasUnacknowledged = false;

var itemsRoot = document.getElementById('surface-items');
var footer = document.getElementById('surface-footer');
var titleEl = document.getElementById('surface-title');
var styleBadge = document.getElementById('surface-style');
var toastEl = document.getElementById('surface-toast');

function showToast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  setTimeout(function () { toastEl.classList.remove('visible'); }, ms || 3000);
}

function statusClass(s) {
  if (s === 'done') return 'status-done';
  if (s === 'active') return 'status-active';
  if (s === 'blocked') return 'status-blocked';
  return 'status-pending';
}

function renderItem(item) {
  var status = item.status || 'pending';
  var div = document.createElement('div');
  div.className = 'surface-item';
  div.id = 'item-' + item.id;
  div.dataset.type = item.type || 'task';

  var badge = document.createElement('button');
  badge.className = 'status-badge ' + statusClass(status);
  badge.textContent = status;
  badge.title = 'Click to cycle status';
  badge.addEventListener('click', function () { cycleStatus(item.id); });

  var body = document.createElement('div');
  body.className = 'surface-item-body';

  var label = document.createElement('div');
  label.className = 'surface-item-label';
  label.textContent = item.label || item.id;
  body.appendChild(label);

  if (item.description) {
    var desc = document.createElement('div');
    desc.className = 'surface-item-desc';
    desc.innerHTML = sanitize(item.description);
    body.appendChild(desc);
  }

  div.appendChild(badge);
  div.appendChild(body);
  return div;
}

function renderEmpty() {
  itemsRoot.innerHTML = '';
  var msg = document.createElement('div');
  msg.className = 'surface-empty';
  msg.textContent = 'No surface document for this session yet. The agent populates it via caco_mutate_surface.';
  itemsRoot.appendChild(msg);
}

function render() {
  if (!doc) { renderEmpty(); updateFooter(); return; }
  titleEl.textContent = doc.style === 'roadmap' ? 'Roadmap' : 'Session Surface';
  styleBadge.textContent = doc.style || '';
  var visibleItems = doc.items.map(function (it) {
    var dirty = doc.changes && doc.changes[it.id];
    return dirty ? dirty : it;
  });
  itemsRoot.innerHTML = '';
  if (visibleItems.length === 0) {
    renderEmpty();
  } else {
    visibleItems.forEach(function (item) { itemsRoot.appendChild(renderItem(item)); });
  }
  updateFooter();
}

function updateFooter() {
  if (!doc) { footer.textContent = ''; return; }
  var dirtyCount = doc.changes ? Object.keys(doc.changes).length : 0;
  hasUnacknowledged = dirtyCount > 0;
  if (dirtyCount > 0) {
    footer.textContent = 'Agent will see your changes on its next response. (' + dirtyCount + ' unack)';
    footer.classList.add('has-changes');
  } else {
    footer.textContent = '';
    footer.classList.remove('has-changes');
  }
}

function sessionId() {
  return window.appletAPI && window.appletAPI.getSessionId ? window.appletAPI.getSessionId() : null;
}

async function fetchSurface() {
  var sid = sessionId();
  if (!sid) { doc = null; render(); return; }
  try {
    var res = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/surface');
    if (res.status === 404) { doc = null; render(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    doc = await res.json();
    render();
  } catch (e) {
    showToast('Failed to load surface: ' + e.message);
  }
}

function cycleStatus(itemId) {
  // Compute the post-edit item locally, append to put queue.
  if (!doc) return;
  var current = (doc.changes && doc.changes[itemId]) || doc.items.find(function (it) { return it.id === itemId; });
  if (!current) return;
  var nextItem = Object.assign({}, current, { status: nextStatus(current.status || 'pending') });

  // Optimistic local render — visible immediately.
  doc.changes = Object.assign({}, doc.changes || {}, {});
  doc.changes[itemId] = nextItem;
  render();

  pendingPuts = pendingPuts.then(function () { return putItem(itemId, nextItem); });
}

async function putItem(itemId, item) {
  var sid = sessionId();
  if (!sid || !doc) return;
  try {
    var res = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/surface/changes/' + encodeURIComponent(itemId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataToken: doc.dataToken, item: item }),
    });
    var body = await res.json();
    if (body.ok) {
      doc.dataToken = body.dataToken;
      updateFooter();
      return;
    }
    if (body.reason === 'stale') {
      // Refresh, then re-apply the user's intent (re-cycle from new state) — but
      // only once. To keep things simple in V1 we just refetch and drop the local edit.
      await fetchSurface();
      showToast('Surface changed remotely. Try again.');
      return;
    }
    if (body.reason === 'unknown-item') {
      await fetchSurface();
      showToast('Item no longer exists.');
      return;
    }
    showToast('Update failed: ' + (body.reason || 'unknown'));
  } catch (e) {
    showToast('Network error: ' + e.message);
  }
}

function onStateBus() {
  if (!window.appletAPI) return;
  if (window.appletAPI.onSessionChange) {
    window.appletAPI.onSessionChange(function () { fetchSurface(); });
  }
  if (window.appletAPI.onSessionEvent) {
    window.appletAPI.onSessionEvent(function (event) {
      if (event && event.type === 'surface.updated') {
        fetchSurface();
      }
    });
  }
}

// Boot: defer to next tick so appletAPI is wired.
setTimeout(function () {
  onStateBus();
  fetchSurface();
}, 0);

// Refresh when the tab regains focus.
window.addEventListener('focus', function () { fetchSurface(); });
