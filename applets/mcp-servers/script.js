/**
 * MCP Authentication Applet
 * 
 * Lists MCP servers and their OAuth authentication status.
 * Allows users to authenticate via popup flow.
 */

// State
var servers = [];

// DOM elements
var listEl = document.getElementById('server-list');
var emptyEl = document.getElementById('empty-state');
var errorEl = document.getElementById('error-state');

/**
 * Escape string for safe use in HTML attributes (data-* values)
 */
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }

/**
 * Fetch servers from API and update display
 */
async function fetchServers() {
  listEl.innerHTML = '<div class="loading">Loading servers...</div>';
  listEl.style.display = 'block';
  emptyEl.style.display = 'none';
  errorEl.style.display = 'none';
  
  try {
    var res = await fetch('/api/mcp/auth/servers');
    var data = await res.json();
    
    servers = data.servers;
    
    if (servers.length === 0) {
      listEl.style.display = 'none';
      emptyEl.style.display = 'block';
      updateAppletState();
      return;
    }
    
    listEl.innerHTML = servers.map(renderServer).join('');
    updateAppletState();
    
  } catch (err) {
    listEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.querySelector('.error-message').textContent = 'Failed to load servers: ' + err.message;
  }
}

/**
 * Render a single server card
 */
function renderServer(server) {
  var now = Date.now();
  var isExpired = server.expiresAt && server.expiresAt < now;
  var isOk = !server.needsAuth && !server.needsClientId && !isExpired;
  var needsClientId = server.needsClientId;
  var needsAuth = server.needsAuth && !needsClientId;
  
  var escapedId = escapeAttr(server.id);
  
  // Status icon
  var icon = (isOk && !server.error) ? '<span class="status-icon status-ok">&#x2713;</span>'
    : '<span class="status-icon status-bad">&#x2717;</span>';
  
  // Action link — always show Authenticate, discovery may resolve missing clientId
  var actionHtml = '';
  if (needsAuth || isExpired || server.error || needsClientId) {
    actionHtml = '<a href="#" class="auth-link" data-action="authenticate" data-server-id="' + escapedId + '">Authenticate</a>';
  } else if (isOk) {
    actionHtml = '<a href="#" class="auth-link" data-action="authenticate" data-server-id="' + escapedId + '">Re-authenticate</a>';
  }
  
  // Error message
  var errorHtml = server.error ? '<div class="server-error">' + escapeHtml(server.error) + '</div>' : '';
  
  return '<div class="server-card" data-server-id="' + escapedId + '">' +
    '<div class="server-row">' +
      icon +
      '<span class="server-id">' + escapeHtml(server.id) + '</span>' +
      '<span class="server-action">' + actionHtml + '</span>' +
    '</div>' +
    '<div class="server-url">' + escapeHtml(server.url) + '</div>' +
    errorHtml +
  '</div>';
}

/**
 * Open OAuth popup for authentication
 */
function authenticate(serverId) {
  var popup = window.open(
    '/api/mcp/auth/start?server=' + encodeURIComponent(serverId) + '&origin=' + encodeURIComponent(location.origin),
    'mcp-auth-' + serverId,
    'width=500,height=700,popup=yes'
  );
  
  if (!popup) {
    alert('Popup blocked. Please allow popups for this site.');
  }
}

/**
 * Save client ID configuration
 */
async function saveClientId(serverId, inputElement) {
  var clientId = inputElement.value.trim();
  
  if (!clientId) {
    alert('Please enter a client ID');
    return;
  }
  
  try {
    var res = await fetch('/api/mcp/auth/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: serverId, clientId: clientId })
    });
    
    var data = await res.json();
    
    if (!data.ok) {
      alert('Error: ' + (data.error || 'Failed to save'));
      return;
    }
    
    // Refresh the list
    fetchServers();
    
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

/**
 * Update applet state for agent visibility
 */
function updateAppletState() {
  if (typeof setAppletState === 'function') {
    var pendingCount = servers.filter(function(s) {
      return s.needsAuth || s.needsClientId;
    }).length;
    
    setAppletState({
      serverCount: servers.length,
      pendingAuthCount: pendingCount
    });
  }
}

/**
 * MCP Server & Tool Discovery
 */

var mcpServerContent = document.getElementById('mcp-server-content');
var mcpTelemetryEl = document.getElementById('mcp-telemetry');
var editConfigLink = document.getElementById('edit-config-link');
var mcpRefreshBtn = document.getElementById('refresh-btn');
var mcpCollapsed = {};

var STATUS_ICONS = {
  'connected': '<span class="status-icon status-ok">✓</span>',
  'failed': '<span class="status-icon status-bad">✗</span>',
  'needs-auth': '<span class="status-icon status-auth">🔑</span>',
  'pending': '<span class="status-icon status-pending">⏳</span>',
  'disabled': '<span class="status-icon status-disabled">○</span>',
  'not_configured': '<span class="status-icon status-disabled">○</span>'
};

var mcpServersCache = null;

async function fetchMcpServers() {
  mcpServerContent.innerHTML = '<div class="loading">Loading servers...</div>';
  try {
    // Scope to the VIEWED session so the applet shows its per-session tool state
    // (deferred/enabled), not the most-recently-active session's. getSessionId may be
    // null (no active session) — then the server falls back to its default target.
    var sid = window.appletAPI && window.appletAPI.getSessionId ? window.appletAPI.getSessionId() : null;
    var url = sid ? '/api/mcp/servers?sessionId=' + encodeURIComponent(sid) : '/api/mcp/servers';
    var res = await fetch(url);
    var data = await res.json();

    if (data.configExists && editConfigLink) {
      editConfigLink.href = '/?applet=text-editor&path=' + encodeURIComponent(data.configPath);
      editConfigLink.style.display = 'inline';
    }

    if (!data.clientRunning) {
      mcpServersCache = null;
      renderTelemetry(null);
      mcpServerContent.innerHTML = '<div class="mcp-empty">Start a session to discover servers and tools</div>';
      return;
    }

    mcpServersCache = data.servers;
    renderTelemetry(data.telemetry);
    renderMcpServers();
  } catch (err) {
    mcpServersCache = null;
    renderTelemetry(null);
    mcpServerContent.innerHTML = '<div class="mcp-empty">Failed to load: ' + escapeHtml(err.message) + '</div>';
  }
}

/**
 * Ground-truth telemetry banner (spec-tool-reveal B0). Every value is a TOKEN
 * count from the SDK's OWN accounting for the current context window — not our
 * per-tool ÷4 estimate. `toolDefinitionsTokens`/`mcpToolsTokens` EXCLUDE deferred
 * tools, so "tool definitions" is the number that drops when deferral lands.
 * null when the session is uninitialized (no request has loaded tools yet).
 */
function renderTelemetry(t) {
  if (!mcpTelemetryEl) return;
  if (!t) {
    mcpTelemetryEl.style.display = 'none';
    mcpTelemetryEl.innerHTML = '';
    return;
  }
  function tokens(n) { return Number(n || 0).toLocaleString(); }
  function stat(label, val, title, extraClass) {
    return '<span class="mcp-tele-stat ' + (extraClass || '') + '" title="' + escapeAttr(title) + '">' +
      '<span class="mcp-tele-val">' + tokens(val) + '</span>' +
      '<span class="mcp-tele-label">' + escapeHtml(label) + '</span>' +
      '</span>';
  }

  // Line 1 — the point of this banner: what the tool definitions cost the model
  // every turn (exact SDK count, excludes deferred tools). MCP shown as a subset.
  var mcp = t.mcpToolsTokens || 0;
  var toolsLine =
    '<div class="mcp-tele-line">' +
      stat('tool-definition tokens', t.toolDefinitionsTokens, 'Exact SDK token count of ALL tool definitions (name + description + schema) sent to the model this turn. EXCLUDES deferred tools — this is the number that drops when tools are deferred. Compare against the ÷4 estimates on each tool below.', 'mcp-tele-primary') +
      '<span class="mcp-tele-sub" title="The portion of tool-definition tokens contributed by MCP-server tools (excludes deferred).">of which MCP ' + tokens(mcp) + '</span>' +
    '</div>';

  // Line 2 — the rest of the context window, so the tool cost has a denominator.
  var windowLine =
    '<div class="mcp-tele-line mcp-tele-context">' +
      stat('system-prompt tokens', t.systemTokens, 'Tokens in the system prompt (Caco\'s instructions to the model).') +
      stat('history tokens', t.conversationTokens, 'Tokens from the conversation so far (user + assistant + tool messages) currently in the context window.') +
      stat('window total', t.totalTokens, 'System + history + tool definitions = the full prompt sent this turn.') +
      (t.tokenLimit ? '<span class="mcp-tele-sub" title="The model\'s maximum prompt size (from the SDK usage_info event). window total / this = how full the context window is.">of ' + tokens(t.tokenLimit) + ' limit</span>' : '') +
    '</div>';

  // Line 3 — last-turn cache split: the DIRECT cache hit/miss signal. cache-read is
  // the warm HIT (cheap); cache-write is the MISS (fresh tokens written). A warm turn
  // is mostly read; a large write near window-total means a COLD/busted cache (the
  // one-time cost a tool reveal incurs). Shown only once a turn has completed.
  var cacheLine = '';
  if (t.lastCacheReadTokens > 0 || t.lastCacheWriteTokens > 0) {
    var cacheTotal = (t.lastCacheReadTokens || 0) + (t.lastCacheWriteTokens || 0);
    var missPct = cacheTotal > 0 ? Math.round((t.lastCacheWriteTokens || 0) / cacheTotal * 100) : 0;
    cacheLine =
      '<div class="mcp-tele-line mcp-tele-context">' +
        '<span class="mcp-tele-cachelabel">last turn:</span>' +
        stat('cache-read (hit)', t.lastCacheReadTokens, 'Tokens READ from the prompt cache last turn — the warm, cheap part of the prompt. High = good (cache is warm).') +
        stat('cache-write (miss)', t.lastCacheWriteTokens, 'Tokens WRITTEN to the prompt cache last turn — the cold part that had to be freshly processed. This is THE cache-miss number: small on a warm turn; large (near window total) means the cache was cold or busted (e.g. by a tool-block change). This is the one-time cost a tool reveal incurs.', 'mcp-tele-miss') +
        '<span class="mcp-tele-sub" title="Share of the last turn\'s cached prompt that was a MISS (write / (read+write)). ~0% = fully warm; ~100% = cold turn.">' + missPct + '% miss</span>' +
    '</div>';
  }

  mcpTelemetryEl.innerHTML =
    '<div class="mcp-tele-title" title="Live token counts from the SDK for the first active session. The ≈ estimates under each tool are Caco\'s ÷4 approximation; these are the SDK\'s real numbers.">context window · all values are tokens · <span class="mcp-tele-src">SDK ground truth</span></div>' +
    toolsLine + windowLine + cacheLine;
  mcpTelemetryEl.style.display = 'block';
}

// Re-render from the cached payload — used by twist (expand/collapse) so a toggle
// never re-fetches. Only fetchMcpServers() (initial load + refresh) hits the network.
function renderMcpServers() {
  if (!mcpServersCache) return;
  if (mcpServersCache.length === 0) {
    mcpServerContent.innerHTML = '<div class="mcp-empty">No MCP servers configured</div>';
    return;
  }
  mcpServerContent.innerHTML = mcpServersCache.map(renderMcpServer).join('');
}

var mcpToolCollapsed = {};

function renderMcpServer(server) {
  var icon = STATUS_ICONS[server.status] || STATUS_ICONS['disabled'];
  var toolCount = server.tools.length;
  var toolLabel = toolCount === 0 ? 'no tools' : toolCount + ' tool' + (toolCount === 1 ? '' : 's');
  var isCollapsed = mcpCollapsed[server.name] !== false;
  var chevron = isCollapsed ? '▸' : '▾';
  var escapedName = escapeAttr(server.name);

  var toolsHtml = '';
  if (!isCollapsed && toolCount > 0) {
    toolsHtml = '<div class="mcp-tool-list">' + server.tools.map(renderMcpTool).join('') + '</div>';
  }

  var errorHtml = server.error ? '<div class="server-error">' + escapeHtml(server.error) + '</div>' : '';

  // Manual defer toggle — real MCP servers only (Built-in/Caco pseudo-servers have
  // source:'caco'). Reflects the system-wide manual-defer DEFAULT for this server.
  // Hidden when it has no purpose: nothing is manually deferred AND every tool is
  // already deferred/disabled this session (no enabled tool left to defer). The
  // re-enable action stays visible whenever the manual default is on.
  var deferHtml = '';
  if (server.source !== 'caco') {
    var isDeferred = server.deferred === true;
    var hasEnabledTool = server.tools.some(function (t) { return (t.state || 'enabled') === 'enabled'; });
    if (isDeferred || hasEnabledTool) {
      var deferTitle = isDeferred
        ? 'This MCP server is deferred system-wide (operator defer or auto-deferred after going unused): its tool definitions are removed from every turn (saving those tokens) and it stays deferred in new sessions until you re-enable here. Click to RE-ENABLE for all sessions. Applies live to all active sessions.'
        : 'Manually defer this MCP server: remove all its tool definitions from every future turn to save tokens. WARNING: applying this to a live/warm session busts the prompt cache — a one-time re-process of the ENTIRE context window of every active session on its next turn (see the token banner above). Cheap on an idle session, expensive mid-conversation. Deferred servers are re-enableable and seed into new sessions.';
      deferHtml = '<button type="button" class="mcp-defer-btn' + (isDeferred ? ' mcp-defer-on' : '') +
        '" data-defer-server="' + escapedName + '" data-deferred="' + (isDeferred ? '1' : '0') +
        '" title="' + escapeAttr(deferTitle) + '">' + (isDeferred ? 'deferred' : 'defer') + '</button>';
    }
  }

  return '<div class="mcp-server-card">' +
    '<div class="mcp-server-row" data-server="' + escapedName + '">' +
      '<span class="mcp-chevron">' + chevron + '</span>' +
      icon +
      '<span class="mcp-server-name">' + escapeHtml(server.name) + '</span>' +
      '<span class="mcp-tool-count">' + toolLabel + '</span>' +
      deferHtml +
    '</div>' +
    errorHtml +
    toolsHtml +
  '</div>';
}

function fmtTokens(n) {
  return '≈' + Number(n).toLocaleString() + ' token' + (n === 1 ? '' : 's');
}

// Humanize an active-clock age (seconds of real tool-use time, not calendar time).
function fmtAge(seconds) {
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

// Single right-side status badge — exactly one of four presentation states:
//   active     (yellow) enabled + observed, shows its known per-turn token cost
//   unobserved (grey)   enabled but schema not yet resolved — cost unknown
//   deferred   (green)  dynamically excluded this session (auto/manual defer), saving
//                       tokens, re-enableable live
//   disabled   (grey)   permanent policy (hard-disabled Caco / policy-excluded builtin);
//                       no cost, NOT re-enableable
// Age ("22m idle" / "never used") is shown as a muted prefix where it is meaningful
// (active/deferred), never on disabled tools. No double-labeling.
function stateBadge(tool) {
  var state = tool.state || 'enabled';
  var age = tool.ageActiveSeconds;
  var hasAge = age !== undefined;
  var ageLabel = !hasAge ? '' : (age === null ? 'never used' : fmtAge(age) + ' idle');
  var agePrefix = ageLabel ? '<span class="mcp-age">' + escapeHtml(ageLabel) + '</span> ' : '';

  if (state === 'disabled') {
    return '<span class="mcp-state-disabled" title="Disabled by Caco policy: not sent to the model and not re-enableable (a hard-disabled Caco tool, or a policy-excluded / platform-absent built-in such as the shell family). Contributes no per-turn tokens.">(disabled)</span>';
  }
  if (state === 'deferred') {
    var known = tool.knownTokenCost != null ? ' · ' + fmtTokens(tool.knownTokenCost) : '';
    var dt = 'Deferred: excluded from the model this session to save per-turn tokens; re-enableable live via caco_enable_tools.'
      + (tool.knownTokenCost != null ? ' Last-known per-turn definition size: ' + fmtTokens(tool.knownTokenCost) + '.' : ' Size not yet known (never observed).')
      + (ageLabel ? ' Last used: ' + ageLabel + ' (active-clock).' : '');
    return agePrefix + '<span class="mcp-state-deferred" title="' + escapeAttr(dt) + '">deferred' + escapeHtml(known) + '</span>';
  }
  // enabled:
  if (tool.observed) {
    var wouldDefer = tool.wouldDefer ? ' Eligible + stale — would auto-defer on the next cold session resume.' : '';
    // Observed and priceable → show the token cost. Observed but schema-less (some MCP
    // tools carry no input_schema) → it IS active/in-model, just not priceable: show
    // "active" rather than mislabeling it "unobserved".
    if (tool.tokenCost != null) {
      return agePrefix + '<span class="mcp-token-cost" title="Estimated per-turn tokens: full serialized JSON tool definition (name + description + schema) ÷ 4.' + escapeAttr(wouldDefer) + '">' + escapeHtml(fmtTokens(tool.tokenCost)) + '</span>';
    }
    return agePrefix + '<span class="mcp-active" title="Active: in the current turn\'s resolved tool set, but it carries no input schema to price (per-turn cost is negligible).' + escapeAttr(wouldDefer) + '">active</span>';
  }
  return '<span class="mcp-unobserved" title="Enabled, but not in the current turn\'s resolved tool set — its schema (and true token cost) is pulled after a request loads it.">unobserved <span class="mcp-info">ⓘ</span></span>';
}

function renderMcpTool(tool) {
  var isCollapsed = mcpToolCollapsed[tool.namespacedName] !== false;
  var chevron = isCollapsed ? '▸' : '▾';
  var escapedNs = escapeAttr(tool.namespacedName);
  var state = tool.state || 'enabled';
  // Grey the row name only for policy-disabled tools; deferred stays normal (its green
  // badge is a positive, money-saving state, not an error).
  var dim = state === 'disabled';

  var badgeHtml = stateBadge(tool);

  var propsHtml = '';
  if (!isCollapsed) {
    var rows = '';
    rows += toolPropRow('description', tool.description ? escapeHtml(tool.description) : '<span class="mcp-dim">(none)</span>');
    if (tool.parameters) {
      // Schema known (enabled-observed, or a deferred builtin whose schema we have).
      rows += toolPropRow('parameters', '<pre class="mcp-schema">' + escapeHtml(JSON.stringify(tool.parameters, null, 2)) + '</pre>');
      if (tool.instructions) rows += toolPropRow('instructions', '<pre class="mcp-schema">' + escapeHtml(tool.instructions) + '</pre>');
    } else if (state === 'enabled' && !tool.observed) {
      rows += toolPropRow('parameters', '<span class="mcp-unobserved">unobserved <span class="mcp-info" title="Pulled after a request loads this tool.">ⓘ</span></span>');
    }
    propsHtml = '<dl class="mcp-tool-props">' + rows + '</dl>';
  }

  var rowClass = 'mcp-tool-row' + (dim ? ' mcp-tool-disabled' : '');
  return '<div class="mcp-tool">' +
    '<div class="' + rowClass + '" data-tool="' + escapedNs + '">' +
      '<span class="mcp-chevron">' + chevron + '</span>' +
      '<span class="mcp-tool-name">' + escapeHtml(tool.name) + '</span>' +
      badgeHtml +
    '</div>' +
    propsHtml +
  '</div>';
}

function toolPropRow(key, valHtml) {
  return '<div class="mcp-prop-row"><dt class="mcp-prop-key">' + escapeHtml(key) + '</dt><dd class="mcp-prop-val">' + valHtml + '</dd></div>';
}

function toggleMcpServer(name) {
  if (mcpCollapsed[name] === false) {
    mcpCollapsed[name] = true;
  } else {
    mcpCollapsed[name] = false;
  }
  renderMcpServers();
}

function toggleMcpTool(ns) {
  if (mcpToolCollapsed[ns] === false) {
    mcpToolCollapsed[ns] = true;
  } else {
    mcpToolCollapsed[ns] = false;
  }
  renderMcpServers();
}

mcpServerContent.addEventListener('click', function(event) {
  // Defer toggle takes precedence and must not also collapse the row.
  var deferBtn = event.target.closest('.mcp-defer-btn');
  if (deferBtn) {
    event.stopPropagation();
    var server = deferBtn.getAttribute('data-defer-server');
    var makeDeferred = deferBtn.getAttribute('data-deferred') !== '1';
    setServerDeferred(server, makeDeferred, deferBtn);
    return;
  }
  var toolRow = event.target.closest('.mcp-tool-row');
  if (toolRow) {
    var ns = toolRow.getAttribute('data-tool');
    if (ns) toggleMcpTool(ns);
    return;
  }
  var row = event.target.closest('.mcp-server-row');
  if (!row) return;
  var name = row.getAttribute('data-server');
  if (name) toggleMcpServer(name);
});

async function setServerDeferred(server, deferred, btn) {
  if (btn) { btn.disabled = true; btn.textContent = deferred ? 'deferring…' : 'enabling…'; }
  try {
    var res = await fetch('/api/mcp/servers/' + encodeURIComponent(server) + '/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deferred: deferred })
    });
    var data = await res.json();
    if (!data.ok) { alert('Defer failed: ' + (data.error || 'unknown')); }
    else if (data.failedSessions && data.failedSessions.length) {
      alert('Defer saved, but ' + data.failedSessions.length +
        ' active session(s) could not be updated live — restart them to apply.');
    }
  } catch (err) {
    alert('Defer failed: ' + err.message);
  }
  // Re-fetch to reflect the new state + updated token banner (the whole point).
  fetchMcpServers();
}

// Refresh button: the applet is IIFE-wrapped, so the inline onclick in
// content.html can't reach fetchMcpServers — wire it here instead.
if (mcpRefreshBtn) mcpRefreshBtn.addEventListener('click', fetchMcpServers);

// Re-fetch on session switch so the applet reflects the newly-viewed session's
// per-session tool state (matches git-status / files / session-surface).
// onSessionChange fires an immediate callback with the CURRENT session at
// registration time; dedupe it against the initial load below so opening the applet
// on an active session doesn't double-fetch (each fetch fans out SDK metadata calls).
var lastFetchedSid = window.appletAPI && window.appletAPI.getSessionId ? window.appletAPI.getSessionId() : null;
if (window.appletAPI && window.appletAPI.onSessionChange) {
  window.appletAPI.onSessionChange(function (sid) {
    if (sid === lastFetchedSid) return; // immediate initial callback / no-op repeat
    lastFetchedSid = sid;
    fetchMcpServers();
  });
}

// Listen for auth completion messages from popup
// Only accept messages from same origin to prevent cross-origin attacks
window.addEventListener('message', function(event) {
  if (event.origin !== location.origin) {
    return; // Ignore messages from other origins
  }
  if (event.data && event.data.type === 'mcp-auth-complete') {
    fetchServers();
  }
  if (event.data && event.data.type === 'mcp-auth-error') {
    // Error is stored in server state, refresh will show it
    fetchServers();
  }
});

// Event delegation for button clicks (avoids inline handlers with server IDs)
listEl.addEventListener('click', function(event) {
  var target = event.target;
  if (!target.matches) return;
  
  // Handle both buttons and links
  var actionEl = target.matches('[data-action]') ? target : target.closest('[data-action]');
  if (!actionEl) return;
  
  event.preventDefault();
  var action = actionEl.getAttribute('data-action');
  var serverId = actionEl.getAttribute('data-server-id');
  
  if (action === 'authenticate' && serverId) {
    authenticate(serverId);
  } else if (action === 'save-client-id' && serverId) {
    var form = target.closest('.client-id-form');
    var input = form ? form.querySelector('.client-id-input') : null;
    if (input) {
      saveClientId(serverId, input);
    }
  } else if (action === 'retry') {
    fetchServers();
  }
});

// Event delegation for Enter key in client ID input
listEl.addEventListener('keypress', function(event) {
  if (event.key !== 'Enter') return;
  
  var target = event.target;
  if (!target.matches || !target.matches('.client-id-input')) return;
  
  var form = target.closest('.client-id-form');
  var serverId = form ? form.getAttribute('data-server-id') : null;
  if (serverId) {
    saveClientId(serverId, target);
  }
});

// Initial load
fetchMcpServers();
fetchServers();
