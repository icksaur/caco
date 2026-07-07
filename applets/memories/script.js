/**
 * Memories applet — view and remove persistent cross-session memory entries.
 * Reads GET /api/memory; deletes via DELETE /api/memory/:key and re-renders from
 * the response's `entries` (no optimistic mutation). See docs/spec-memory.md.
 */

function el(id) { return document.getElementById(id); }

function show(which) {
  el('mem-loading').style.display = which === 'loading' ? 'block' : 'none';
  el('mem-error').style.display = which === 'error' ? 'block' : 'none';
  el('mem-empty').style.display = which === 'empty' ? 'block' : 'none';
}

function renderEntries(payload) {
  const list = el('mem-list');
  list.innerHTML = '';
  const entries = payload && payload.entries ? payload.entries : {};
  const keys = Object.keys(entries).sort();

  el('mem-count').textContent = `${keys.length} / ${payload.capacity ?? 50}`;

  if (keys.length === 0) {
    show('empty');
    return;
  }
  show('none');

  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'mem-row';

    const body = document.createElement('div');
    body.className = 'mem-body';
    const k = document.createElement('div');
    k.className = 'mem-key';
    k.textContent = key;
    const v = document.createElement('div');
    v.className = 'mem-value';
    v.textContent = entries[key];
    body.appendChild(k);
    body.appendChild(v);

    const del = document.createElement('button');
    del.className = 'mem-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteEntry(key));

    row.appendChild(body);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function loadMemories() {
  show('loading');
  el('mem-list').innerHTML = '';
  try {
    const res = await fetch('/api/memory');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderEntries(payload);
  } catch (err) {
    show('error');
    el('mem-error').textContent = `Failed to load memories: ${err.message}`;
  }
}

async function deleteEntry(key) {
  if (!window.confirm(`Delete memory "${key}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderEntries(payload);
  } catch (err) {
    show('error');
    el('mem-error').textContent = `Failed to delete "${key}": ${err.message}`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    el('mem-refresh').addEventListener('click', loadMemories);
    loadMemories();
  });
} else {
  el('mem-refresh').addEventListener('click', loadMemories);
  loadMemories();
}
