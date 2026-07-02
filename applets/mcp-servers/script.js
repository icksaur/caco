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
var editConfigLink = document.getElementById('edit-config-link');
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
    var res = await fetch('/api/mcp/servers');
    var data = await res.json();

    if (data.configExists && editConfigLink) {
      editConfigLink.href = '/?applet=text-editor&path=' + encodeURIComponent(data.configPath);
      editConfigLink.style.display = 'inline';
    }

    if (!data.clientRunning) {
      mcpServersCache = null;
      mcpServerContent.innerHTML = '<div class="mcp-empty">Start a session to discover servers and tools</div>';
      return;
    }

    mcpServersCache = data.servers;
    renderMcpServers();
  } catch (err) {
    mcpServersCache = null;
    mcpServerContent.innerHTML = '<div class="mcp-empty">Failed to load: ' + escapeHtml(err.message) + '</div>';
  }
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

  return '<div class="mcp-server-card">' +
    '<div class="mcp-server-row" data-server="' + escapedName + '">' +
      '<span class="mcp-chevron">' + chevron + '</span>' +
      icon +
      '<span class="mcp-server-name">' + escapeHtml(server.name) + '</span>' +
      '<span class="mcp-tool-count">' + toolLabel + '</span>' +
    '</div>' +
    errorHtml +
    toolsHtml +
  '</div>';
}

function fmtTokens(n) {
  return '≈' + Number(n).toLocaleString() + ' token' + (n === 1 ? '' : 's');
}

function renderMcpTool(tool) {
  var isCollapsed = mcpToolCollapsed[tool.namespacedName] !== false;
  var chevron = isCollapsed ? '▸' : '▾';
  var escapedNs = escapeAttr(tool.namespacedName);

  var costHtml = tool.observed
    ? '<span class="mcp-token-cost" title="Estimated per-turn tokens: full serialized JSON tool definition (name + description + schema, keys and values) ÷ 4">' + escapeHtml(fmtTokens(tool.tokenCost)) + '</span>'
    : '<span class="mcp-unobserved" title="This tool is not in the current turn\'s resolved tool set. Its schema (and true token cost) is pulled after a request loads it — deferred/on-demand tools populate once used.">unobserved <span class="mcp-info">ⓘ</span></span>';

  var propsHtml = '';
  if (!isCollapsed) {
    var rows = '';
    rows += toolPropRow('description', tool.description ? escapeHtml(tool.description) : '<span class="mcp-dim">(none)</span>');
    if (tool.observed) {
      var paramsStr = tool.parameters ? JSON.stringify(tool.parameters, null, 2) : '(none)';
      rows += toolPropRow('parameters', '<pre class="mcp-schema">' + escapeHtml(paramsStr) + '</pre>');
      if (tool.instructions) rows += toolPropRow('instructions', '<pre class="mcp-schema">' + escapeHtml(tool.instructions) + '</pre>');
    } else {
      rows += toolPropRow('parameters', '<span class="mcp-unobserved">unobserved <span class="mcp-info" title="Pulled after a request loads this tool.">ⓘ</span></span>');
    }
    propsHtml = '<dl class="mcp-tool-props">' + rows + '</dl>';
  }

  return '<div class="mcp-tool">' +
    '<div class="mcp-tool-row" data-tool="' + escapedNs + '">' +
      '<span class="mcp-chevron">' + chevron + '</span>' +
      '<span class="mcp-tool-name">' + escapeHtml(tool.name) + '</span>' +
      costHtml +
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
