(function() {
  var list = document.getElementById('applet-list');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render(applets) {
    var visible = applets.filter(function(a) { return !a.deprecated; });
    if (visible.length === 0) {
      list.innerHTML = '<div class="empty-state">No saved applets yet</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < visible.length; i++) {
      var app = visible[i];
      html += '<a class="applet-card" href="?applet=' + encodeURIComponent(app.slug) + '">';
      html += '<p class="applet-heading"><span class="applet-name">' + esc(app.name) + '</span> <span class="applet-slug">' + esc(app.slug) + '</span></p>';
      html += '<p class="applet-desc">' + esc(app.description || '') + '</p>';
      html += '</a>';
    }
    list.innerHTML = html;
  }

  (async function() {
    try {
      var applets = await window.appletAPI.listApplets();
      if (!applets) applets = [];
      render(applets);
      window.appletAPI.setAppletState({ applets: applets });
    } catch (e) {
      list.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  })();
})();
