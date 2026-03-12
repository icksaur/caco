var sessionId = null;
var sessionCwd = null;
var roadmap = null;

var header = document.getElementById('header');
var docs = document.getElementById('docs');
var steps = document.getElementById('steps');
var empty = document.getElementById('empty');

var statusIcons = { pending: '○', active: '◐', done: '●', blocked: '⊘' };
var statusOrder = ['pending', 'active', 'done', 'blocked'];

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getViewer(path) {
  var ext = path.split('.').pop().toLowerCase();
  if (['md', 'mdx', 'markdown'].indexOf(ext) !== -1) return 'markdown-viewer';
  return 'text-editor';
}

function isAbsPath(s) {
  return s.startsWith('/') || /^[A-Za-z]:[/\\]/.test(s);
}

function isUri(s) {
  return /https?:\/\//.test(s);
}

function extractUri(s) {
  var m = s.match(/(https?:\/\/\S+)/);
  return m ? m[1] : null;
}

function isRelPath(s) {
  return /[/\\]/.test(s) || /\.\w{1,10}$/.test(s);
}

function renderLink(s) {
  // Check for embedded URI first (e.g. "WI: https://...")
  var uri = extractUri(s);
  if (uri) {
    var label = s.replace(uri, '').replace(/[:\s]+$/, '').trim();
    return '<a class="doc-link" href="' + esc(uri) + '" target="_blank" title="' + esc(uri) + '">' + esc(label || uri.split('/').pop() || uri) + '</a>';
  }

  var resolved = s;
  if (!isAbsPath(s) && isRelPath(s) && sessionCwd) {
    var sep = sessionCwd.indexOf('\\') >= 0 ? '\\' : '/';
    resolved = sessionCwd + sep + s;
  }
  var display = s.split(/[/\\]/).pop() || s;
  if (isAbsPath(resolved)) {
    var applet = getViewer(resolved);
    return '<a class="doc-link" href="?applet=' + applet + '&path=' + encodeURIComponent(resolved) + '" title="' + esc(s) + '">' + esc(display) + '</a>';
  }
  return '<span class="doc-text" title="' + esc(s) + '">' + esc(s) + '</span>';
}

async function loadRoadmap() {
  console.log('[ROADMAP] loadRoadmap called, sessionId=' + sessionId, 'cwd=' + sessionCwd);
  if (!sessionId) return;
  try {
    var res = await fetch('/api/sessions/' + sessionId + '/roadmap');
    var data = await res.json();
    if (data.title || (data.steps && data.steps.length)) {
      roadmap = data;
      empty.style.display = 'none';
    } else {
      roadmap = null;
      empty.style.display = '';
    }
    render();
    window.appletAPI.setAppletState({ hasRoadmap: !!roadmap, stepCount: roadmap ? roadmap.steps.length : 0 });
  } catch (e) {
    empty.textContent = 'Error loading roadmap: ' + (e.message || e) + ' (sessionId=' + sessionId + ')';
    empty.style.display = '';
  }
}

async function patchRoadmap(update) {
  await fetch('/api/sessions/' + sessionId + '/roadmap', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  });
  await loadRoadmap();
}

function cycleStatus(idx) {
  if (!roadmap || !roadmap.steps[idx]) return;
  var cur = roadmap.steps[idx].status || 'pending';
  var next = statusOrder[(statusOrder.indexOf(cur) + 1) % statusOrder.length];
  roadmap.steps[idx].status = next;
  patchRoadmap({ steps: roadmap.steps });
}

function render() {
  if (!roadmap) {
    header.innerHTML = '';
    docs.innerHTML = '';
    steps.innerHTML = '';
    return;
  }

  header.innerHTML = roadmap.title ? '<h2>' + esc(roadmap.title) + '</h2>' : '';

  if (roadmap.documents && roadmap.documents.length) {
    var dHtml = '<div class="doc-list">';
    for (var i = 0; i < roadmap.documents.length; i++) {
      dHtml += renderLink(roadmap.documents[i]);
    }
    dHtml += '</div>';
    docs.innerHTML = dHtml;
  } else {
    docs.innerHTML = '';
  }

  if (!roadmap.steps || !roadmap.steps.length) {
    steps.innerHTML = '<div class="no-steps">No steps yet</div>';
    return;
  }

  var html = '';
  for (var si = 0; si < roadmap.steps.length; si++) {
    var s = roadmap.steps[si];
    var status = s.status || 'pending';
    var icon = statusIcons[status] || '○';

    html += '<div class="step step-' + status + '" data-idx="' + si + '">';
    html += '<span class="step-status" data-idx="' + si + '" title="Click to cycle status">' + icon + '</span>';
    html += '<div class="step-body">';
    html += '<div class="step-title">' + esc(s.title) + '</div>';
    if (s.description) {
      html += '<div class="step-desc">' + esc(s.description) + '</div>';
    }
    if (s.context && s.context.length) {
      html += '<div class="step-context">';
      for (var ci = 0; ci < s.context.length; ci++) {
        html += renderLink(s.context[ci]);
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  steps.innerHTML = html;

  steps.querySelectorAll('.step-status').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      cycleStatus(Number(this.getAttribute('data-idx')));
    });
  });
}

window.appletAPI.onSessionChange(function(_id, info) {
  sessionId = info.sessionId;
  sessionCwd = info.cwd;
  loadRoadmap();
});

window.appletAPI.onSessionEvent(function(event) {
  if (event.type === 'session.idle') loadRoadmap();
  if (event.type === 'tool.execution_complete' && event.data && event.data.toolName === 'update_roadmap') loadRoadmap();
});

// Initial load if session is already active
var initId = window.appletAPI.getSessionId();
console.log('[ROADMAP] Init, getSessionId=' + initId);
if (initId) {
  sessionId = initId;
  fetch('/api/sessions/' + initId + '/state').then(function(r) { return r.json(); }).then(function(data) {
    sessionCwd = data.cwd || null;
    loadRoadmap();
  }).catch(function() { loadRoadmap(); });
}
