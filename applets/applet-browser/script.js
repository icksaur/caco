(function() {
  var list = document.getElementById('applet-list');
  var checkbox = document.getElementById('showDeprecated');
  var STORAGE_KEY = 'caco:applet-browser:showDeprecated';

  function getShowDeprecated() {
    try { return window.localStorage.getItem(STORAGE_KEY) === '1'; }
    catch (_e) { return false; }
  }
  function setShowDeprecated(v) {
    try { window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); }
    catch (_e) { /* ignore */ }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var cachedApplets = null;

  function render() {
    if (!cachedApplets) return;
    var showDep = getShowDeprecated();
    var visible = cachedApplets.filter(function(a) {
      return showDep || !a.deprecated;
    });
    if (visible.length === 0) {
      list.innerHTML = '<div class="empty-state">No saved applets yet</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < visible.length; i++) {
      var app = visible[i];
      html += '<a class="applet-card" href="?applet=' + encodeURIComponent(app.slug) + '">';
      html += '<p class="applet-heading"><span class="applet-name">' + esc(app.name) + '</span> <span class="applet-slug">' + esc(app.slug) + '</span>';
      if (app.deprecated) {
        html += ' <span class="ab-deprecated-badge">deprecated → ' + esc(app.replacedBy || 'files') + '</span>';
      }
      html += '</p>';
      html += '<p class="applet-desc">' + esc(app.description || '') + '</p>';
      html += '</a>';
    }
    list.innerHTML = html;
  }

  checkbox.checked = getShowDeprecated();
  checkbox.addEventListener('change', function() {
    setShowDeprecated(checkbox.checked);
    render();
  });

  (async function() {
    try {
      cachedApplets = await window.appletAPI.listApplets();
      if (!cachedApplets) cachedApplets = [];
      render();
      window.appletAPI.setAppletState({ applets: cachedApplets });
    } catch (e) {
      list.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  })();
})();
