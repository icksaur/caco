var sessionId = null;
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

async function loadRoadmap() {
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
    empty.textContent = 'Error loading roadmap';
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
      var d = roadmap.documents[i];
      var name = d.split('/').pop();
      var applet = getViewer(d);
      dHtml += '<a class="doc-link" href="?applet=' + applet + '&path=' + encodeURIComponent(d) + '" title="' + esc(d) + '">' + esc(name) + '</a>';
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
        var c = s.context[ci];
        var cName = c.split('/').pop();
        var cApplet = getViewer(c);
        html += '<a class="context-link" href="?applet=' + cApplet + '&path=' + encodeURIComponent(c) + '">' + esc(cName) + '</a>';
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
  loadRoadmap();
});

window.appletAPI.onSessionEvent(function(event) {
  if (event.type === 'session.idle') loadRoadmap();
  if (event.type === 'tool.execution_complete' && event.data && event.data.toolName === 'update_roadmap') loadRoadmap();
});
