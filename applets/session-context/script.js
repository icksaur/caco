var sessionId = null;
var sessionCwd = null;
var roadmap = null;
var contextFiles = [];
var intentHistory = [];
var sessionNotes = [];

var filesSection = document.getElementById('sc-files');
var filesList = document.getElementById('sc-files-list');
var roadmapSection = document.getElementById('sc-roadmap');
var roadmapHeader = document.getElementById('sc-roadmap-header');
var roadmapDocs = document.getElementById('sc-roadmap-docs');
var roadmapSteps = document.getElementById('sc-roadmap-steps');
var activitySection = document.getElementById('sc-activity');
var activityList = document.getElementById('sc-activity-list');
var notesSection = document.getElementById('sc-notes');
var notesList = document.getElementById('sc-notes-list');
var emptyEl = document.getElementById('sc-empty');

var statusIcons = { pending: '○', active: '◐', done: '●', blocked: '⊘' };
var statusOrder = ['pending', 'active', 'done', 'blocked'];
var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function getViewer(path) {
  var ext = (path.split('.').pop() || '').toLowerCase();
  if (['md', 'mdx', 'markdown'].indexOf(ext) !== -1) return 'markdown-viewer';
  if (['html', 'htm'].indexOf(ext) !== -1) return 'html-viewer';
  if (IMAGE_EXTS.indexOf(ext) !== -1) return 'image-viewer';
  return 'text-editor';
}

function isAbsPath(s) { return s.startsWith('/') || /^[A-Za-z]:[/\\]/.test(s); }
function isUri(s) { return /https?:\/\//.test(s); }
function extractUri(s) { var m = s.match(/(https?:\/\/\S+)/); return m ? m[1] : null; }
function isRelPath(s) { return /[/\\]/.test(s) || /\.\w{1,10}$/.test(s); }

function resolvePath(s) {
  if (isAbsPath(s)) return s;
  if (isRelPath(s) && sessionCwd) {
    var sep = sessionCwd.indexOf('\\') >= 0 ? '\\' : '/';
    return sessionCwd + sep + s;
  }
  return s;
}

function renderLink(s) {
  var uri = extractUri(s);
  if (uri) {
    var label = s.replace(uri, '').replace(/[:\s]+$/, '').trim();
    return '<a class="sc-link" href="' + esc(uri) + '" target="_blank" title="' + esc(uri) + '">' + esc(label || uri.split('/').pop() || uri) + '</a>';
  }
  var resolved = resolvePath(s);
  var display = s.split(/[/\\]/).pop() || s;
  if (isAbsPath(resolved)) {
    var applet = getViewer(resolved);
    return '<a class="sc-link" href="?applet=' + applet + '&path=' + encodeURIComponent(resolved) + '" title="' + esc(resolved) + '">' + esc(display) + '</a>';
  }
  return '<span class="sc-text" title="' + esc(s) + '">' + esc(s) + '</span>';
}

function formatTime(ts) {
  var d = new Date(ts);
  var now = new Date();
  var h = d.getHours().toString().padStart(2, '0');
  var m = d.getMinutes().toString().padStart(2, '0');
  var time = h + ':' + m;
  if (d.toDateString() === now.toDateString()) return time;
  var mon = (d.getMonth() + 1).toString().padStart(2, '0');
  var day = d.getDate().toString().padStart(2, '0');
  return mon + '/' + day + ' ' + time;
}

function hasContent() {
  return contextFiles.length > 0 || roadmap || intentHistory.length > 0 || sessionNotes.length > 0;
}

function updateEmpty() {
  emptyEl.style.display = hasContent() ? 'none' : '';
}

// --- Files section ---

function renderFiles() {
  if (!contextFiles.length) { filesSection.style.display = 'none'; return; }
  filesSection.style.display = '';
  var html = '';
  for (var i = 0; i < contextFiles.length; i++) {
    var path = contextFiles[i];
    var resolved = resolvePath(path);
    var display = path.split(/[/\\]/).pop() || path;
    var applet = getViewer(resolved);
    html += '<div class="sc-file-item">';
    html += '<a class="sc-link" href="?applet=' + applet + '&path=' + encodeURIComponent(resolved) + '" title="' + esc(resolved) + '">' + esc(display) + '</a>';
    html += '</div>';
  }
  filesList.innerHTML = html;
}

// --- Roadmap section ---

async function loadRoadmap() {
  if (!sessionId) return;
  try {
    var res = await fetch('/api/sessions/' + sessionId + '/roadmap');
    var data = await res.json();
    contextFiles = data.contextFiles || [];
    intentHistory = data.intentHistory || [];
    if (data.title || (data.steps && data.steps.length)) {
      roadmap = data;
    } else {
      roadmap = null;
    }
    renderFiles();
    renderRoadmap();
    renderActivity();
    updateEmpty();
    window.appletAPI.setAppletState({
      hasRoadmap: !!roadmap,
      stepCount: roadmap ? roadmap.steps.length : 0,
      fileCount: contextFiles.length
    });
  } catch (e) {
    console.error('[SC] Error loading roadmap:', e);
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

function renderRoadmap() {
  if (!roadmap) {
    roadmapSection.style.display = 'none';
    roadmapHeader.innerHTML = '';
    roadmapDocs.innerHTML = '';
    roadmapSteps.innerHTML = '';
    return;
  }
  roadmapSection.style.display = '';
  var headerHtml = '<h3 class="sc-heading">roadmap</h3>';
  if (roadmap.title) headerHtml += '<div class="sc-roadmap-title">' + esc(roadmap.title) + '</div>';
  roadmapHeader.innerHTML = headerHtml;

  if (roadmap.documents && roadmap.documents.length) {
    var dHtml = '<div class="sc-doc-list">';
    for (var i = 0; i < roadmap.documents.length; i++) dHtml += renderLink(roadmap.documents[i]);
    dHtml += '</div>';
    roadmapDocs.innerHTML = dHtml;
  } else {
    roadmapDocs.innerHTML = '';
  }

  if (!roadmap.steps || !roadmap.steps.length) {
    roadmapSteps.innerHTML = '';
    return;
  }

  var html = '';
  for (var si = 0; si < roadmap.steps.length; si++) {
    var s = roadmap.steps[si];
    var status = statusIcons[s.status] ? s.status : 'pending';
    var icon = statusIcons[status];
    html += '<div class="sc-step sc-step-' + status + '" data-idx="' + si + '">';
    html += '<span class="sc-step-status" data-idx="' + si + '" title="Click to cycle status">' + icon + '</span>';
    html += '<div class="sc-step-body">';
    html += '<div class="sc-step-title">' + esc(s.title) + '</div>';
    if (s.description) html += '<div class="sc-step-desc">' + esc(s.description) + '</div>';
    if (s.context && s.context.length) {
      html += '<div class="sc-step-context">';
      for (var ci = 0; ci < s.context.length; ci++) html += renderLink(s.context[ci]);
      html += '</div>';
    }
    html += '</div></div>';
  }
  roadmapSteps.innerHTML = html;
  roadmapSteps.querySelectorAll('.sc-step-status').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      cycleStatus(Number(this.getAttribute('data-idx')));
    });
  });
}

// --- Activity section ---

function renderActivity() {
  if (!intentHistory.length) { activitySection.style.display = 'none'; return; }
  activitySection.style.display = '';
  var html = '';
  for (var i = intentHistory.length - 1; i >= 0; i--) {
    var item = intentHistory[i];
    html += '<div class="sc-activity-item">';
    html += '<span class="sc-time">' + formatTime(item.ts) + '</span>';
    html += '<span class="sc-activity-text">' + esc(item.text) + '</span>';
    html += '</div>';
  }
  activityList.innerHTML = html;
}

// --- Notes section ---

async function loadNotes() {
  if (!sessionId) return;
  try {
    var res = await fetch('/api/sessions/' + sessionId + '/notes');
    var data = await res.json();
    sessionNotes = data.notes || [];
  } catch { sessionNotes = []; }
  renderNotes();
  updateEmpty();
}

function renderNotes() {
  if (!sessionNotes.length) { notesSection.style.display = 'none'; notesList.innerHTML = ''; return; }
  notesSection.style.display = '';
  var html = '';
  for (var i = 0; i < sessionNotes.length; i++) {
    var n = sessionNotes[i];
    html += '<div class="sc-note">';
    html += '<span class="sc-time">' + formatTime(n.ts) + '</span>';
    html += '<span class="sc-note-text">' + esc(n.text) + '</span>';
    html += '<span class="sc-note-archive" data-ts="' + n.ts + '" title="Archive">⌸</span>';
    html += '</div>';
  }
  notesList.innerHTML = html;
  notesList.querySelectorAll('.sc-note-archive').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      archiveNote(Number(this.getAttribute('data-ts')));
    });
  });
}

async function archiveNote(ts) {
  await fetch('/api/sessions/' + sessionId + '/notes/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: ts })
  });
  loadNotes();
}

// --- Lifecycle ---

function loadAll() {
  loadRoadmap();
  loadNotes();
}

window.appletAPI.onSessionChange(function(_id, info) {
  sessionId = info.sessionId;
  sessionCwd = info.cwd;
  loadAll();
});

window.appletAPI.onSessionEvent(function(event) {
  if (event.type === 'session.idle') loadAll();
  if (event.type === 'tool.execution_complete' && event.data) {
    if (event.data.toolName === 'update_roadmap') loadRoadmap();
    if (event.data.toolName === 'session_note') loadNotes();
  }
  if (event.type === 'caco.context' && event.data && event.data.context) {
    contextFiles = event.data.context.files || [];
    renderFiles();
    updateEmpty();
  }
});

var initId = window.appletAPI.getSessionId();
if (initId) {
  sessionId = initId;
  fetch('/api/sessions/' + initId + '/state').then(function(r) { return r.json(); }).then(function(data) {
    sessionCwd = data.cwd || null;
    loadAll();
  }).catch(function() { loadAll(); });
}
