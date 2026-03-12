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
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  
  // Action link
  var actionHtml = '';
  if (needsClientId) {
    actionHtml = renderClientIdForm(escapedId);
  } else if (needsAuth || isExpired || server.error) {
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
      (needsClientId ? '' : '<span class="server-action">' + actionHtml + '</span>') +
    '</div>' +
    '<div class="server-url">' + escapeHtml(server.url) + '</div>' +
    errorHtml +
    (needsClientId ? actionHtml : '') +
  '</div>';
}

/**
 * Render client ID configuration form
 * @param escapedId - Already HTML-attribute-escaped server ID
 */
function renderClientIdForm(escapedId) {
  return '<div class="client-id-form" data-server-id="' + escapedId + '">' +
    '<input type="text" class="client-id-input" ' +
      'placeholder="Application (client) ID">' +
    '<button class="auth-btn primary" data-action="save-client-id" data-server-id="' + escapedId + '">Save</button>' +
  '</div>' +
  '<div class="client-id-hint">From Azure Portal → App Registrations → Your App</div>';
}

/**
 * Open OAuth popup for authentication
 */
function authenticate(serverId) {
  var popup = window.open(
    '/api/mcp/auth/start?server=' + encodeURIComponent(serverId),
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
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
fetchServers();
