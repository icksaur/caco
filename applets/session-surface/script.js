// session-surface — agent-driven rendering shell.
// Loads surface doc from /api/sessions/:id/surface.
// If customScript is present, evaluates it with bindings: surface, root, mutateChange, appletAPI.
// Agent must define a render(surface) function in customScript.
// Fallback: renders item labels as plain text when no customScript.

var doc = null;
var pendingPuts = Promise.resolve();
var customCleanup = null;

var itemsRoot = document.getElementById('surface-items');
var footer = document.getElementById('surface-footer');
var toastEl = document.getElementById('surface-toast');
var customStyleEl = null;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  setTimeout(function () { toastEl.classList.remove('visible'); }, ms || 3000);
}

function sessionId() {
  return window.appletAPI && window.appletAPI.getSessionId ? window.appletAPI.getSessionId() : null;
}

function mutateChange(itemId, fullItem) {
  if (!doc) return Promise.reject(new Error('No surface document'));
  doc.changes = Object.assign({}, doc.changes || {});
  doc.changes[itemId] = fullItem;
  callRender();
  updateFooter();

  return new Promise(function (resolve) {
    pendingPuts = pendingPuts.then(function () {
      return putItem(itemId, fullItem).then(resolve);
    });
  });
}

async function putItem(itemId, item) {
  var sid = sessionId();
  if (!sid || !doc) return { ok: false, reason: 'no-session' };
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
      return body;
    }
    if (body.reason === 'stale' || body.reason === 'unknown-item') {
      await fetchSurface();
      showToast(body.reason === 'stale' ? 'Surface changed remotely.' : 'Item no longer exists.');
      return body;
    }
    showToast('Update failed: ' + (body.reason || 'unknown'));
    return body;
  } catch (e) {
    showToast('Network error: ' + e.message);
    return { ok: false, reason: 'network' };
  }
}

var agentRender = null;

function callRender() {
  if (!doc) { renderEmpty(); return; }
  if (agentRender) {
    try {
      var result = agentRender(Object.assign({}, doc, { changes: Object.assign({}, doc.changes) }));
      if (typeof result === 'string') itemsRoot.innerHTML = result;
    } catch (e) {
      itemsRoot.innerHTML = '<div class="surface-error">Render error: ' + esc(e.message) + '</div>';
    }
  } else {
    renderFallback();
  }
  updateFooter();
}

function renderFallback() {
  if (!doc || !doc.items || doc.items.length === 0) { renderEmpty(); return; }
  itemsRoot.innerHTML = '';
  doc.items.forEach(function (item) {
    var merged = (doc.changes && doc.changes[item.id]) || item;
    var div = document.createElement('div');
    div.className = 'surface-fallback-item';
    div.id = 'item-' + item.id;
    div.dataset.type = item.type || '';
    div.textContent = merged.label || merged.title || merged.id;
    if (merged.description) {
      var desc = document.createElement('div');
      desc.className = 'surface-fallback-desc';
      desc.textContent = merged.description;
      div.appendChild(desc);
    }
    itemsRoot.appendChild(div);
  });
}

function renderEmpty() {
  itemsRoot.innerHTML = '';
  var msg = document.createElement('div');
  msg.className = 'surface-empty';
  msg.textContent = 'No surface document. The agent populates it via caco_mutate_surface.';
  itemsRoot.appendChild(msg);
}

function updateFooter() {
  if (!doc) { footer.textContent = ''; return; }
  var dirtyCount = doc.changes ? Object.keys(doc.changes).length : 0;
  if (dirtyCount > 0) {
    footer.textContent = 'Your edits will be visible to the agent on its next response. (' + dirtyCount + ' unsent)';
    footer.className = 'has-changes';
  } else if (ackTimer) {
    footer.textContent = '✓ Agent received your edits.';
    footer.className = 'has-ack';
  } else {
    footer.textContent = '';
    footer.className = '';
  }
}

function evalCustomScript(script) {
  if (customCleanup) { try { customCleanup(); } catch (e) { /* ignore */ } customCleanup = null; }
  agentRender = null;
  if (!script) return;

  try {
    var fn = new Function('surface', 'root', 'mutateChange', 'appletAPI',
      script + '\nif (typeof render === "function") return render;');
    var renderFn = fn(
      Object.assign({}, doc, { changes: Object.assign({}, doc.changes || {}) }),
      itemsRoot,
      mutateChange,
      window.appletAPI || {}
    );
    if (typeof renderFn === 'function') {
      agentRender = renderFn;
    }
  } catch (e) {
    itemsRoot.innerHTML = '<div class="surface-error">Script error: ' + esc(e.message) + '</div>';
  }
}

function injectCustomStyle(css) {
  if (customStyleEl) { customStyleEl.remove(); customStyleEl = null; }
  if (!css) return;
  customStyleEl = document.createElement('style');
  customStyleEl.textContent = css;
  document.head.appendChild(customStyleEl);
}

var fetchEpoch = 0;
var lastAckAt = 0;
var ackTimer = null;

async function fetchSurface() {
  var sid = sessionId();
  var epoch = ++fetchEpoch;
  if (!sid) { doc = null; agentRender = null; callRender(); return; }
  try {
    var res = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/surface');
    if (epoch !== fetchEpoch) return; // session changed while fetch was in-flight
    if (res.status === 404) { doc = null; agentRender = null; callRender(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var newDoc = await res.json();
    if (epoch !== fetchEpoch) return; // session changed while parsing
    var scriptChanged = !doc || doc.customScript !== newDoc.customScript;
    var styleChanged = !doc || doc.customStyle !== newDoc.customStyle;
    var prevDirty = (doc && doc.changes) ? Object.keys(doc.changes).length : 0;
    var nextDirty = (newDoc.changes) ? Object.keys(newDoc.changes).length : 0;
    // The agent acknowledged: dirty count dropped from non-zero to zero on a
    // server-initiated refresh. Show a confirmation so the user doesn't read
    // their disappearing edits as data loss.
    if (prevDirty > 0 && nextDirty === 0) {
      lastAckAt = Date.now();
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = setTimeout(function() { ackTimer = null; updateFooter(); }, 6000);
    }
    doc = newDoc;
    if (styleChanged) injectCustomStyle(doc.customStyle);
    if (scriptChanged) evalCustomScript(doc.customScript);
    callRender();
  } catch (e) {
    showToast('Failed to load surface: ' + e.message);
  }
}

function onStateBus() {
  if (!window.appletAPI) return;
  if (window.appletAPI.onSessionChange) {
    window.appletAPI.onSessionChange(function () { fetchSurface(); });
  }
  if (window.appletAPI.onSessionEvent) {
    window.appletAPI.onSessionEvent(function (event) {
      if (event && event.type === 'caco.surface.updated') {
        var sid = sessionId();
        if (sid && event.data && event.data.sessionId && event.data.sessionId !== sid) return;
        fetchSurface();
      }
    });
  }
}

setTimeout(function () {
  onStateBus();
  fetchSurface();
}, 0);

window.addEventListener('focus', function () { fetchSurface(); });
