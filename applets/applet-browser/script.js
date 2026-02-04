(async function() {
  var list = document.getElementById('applet-list');
  
  try {
    var applets = await window.appletAPI.listApplets();
    
    if (!applets || applets.length === 0) {
      list.innerHTML = '<div class="empty-state">No saved applets yet</div>';
      return;
    }
    
    var html = '';
    for (var i = 0; i < applets.length; i++) {
      var app = applets[i];
      html += '<a class="applet-card" href="?applet=' + encodeURIComponent(app.slug) + '">';
      html += '<p class="applet-name">' + app.name + '</p>';
      html += '<p class="applet-slug">' + app.slug + '</p>';
      html += '<p class="applet-desc">' + (app.description || '') + '</p>';
      html += '</a>';
    }
    list.innerHTML = html;
    
    window.appletAPI.setAppletState({ applets: applets });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
  }
})();
