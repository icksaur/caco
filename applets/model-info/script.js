(function () {
  var container = document.getElementById('model-table');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cellText(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return esc(JSON.stringify(val));
    return esc(String(val));
  }

  function buildKeys(models) {
    var seen = ['id'];
    var set = new Set(seen);
    set.add('name');
    for (var i = 0; i < models.length; i++) {
      var keys = Object.keys(models[i]);
      for (var j = 0; j < keys.length; j++) {
        if (!set.has(keys[j])) {
          seen.push(keys[j]);
          set.add(keys[j]);
        }
      }
    }
    return seen;
  }

  function render(models) {
    if (!models || models.length === 0) {
      container.innerHTML = '<div class="empty-state">No models available</div>';
      return;
    }
    var keys = buildKeys(models);
    var html = '';
    for (var r = 0; r < models.length; r++) {
      var m = models[r];
      html += '<section class="mi-card">';
      html += '<h2 class="mi-name">' + esc(m.name || m.id || '(unnamed)') + '</h2>';
      html += '<dl class="mi-props">';
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (!(key in m)) continue;
        html += '<div class="mi-row">';
        html += '<dt class="mi-key">' + esc(key) + '</dt>';
        html += '<dd class="mi-val">' + cellText(m[key]) + '</dd>';
        html += '</div>';
      }
      html += '</dl></section>';
    }
    container.innerHTML = html;
  }

  (async function () {
    try {
      var res = await window.appletAPI.fetch('/api/models/raw');
      var data = await res.json();
      var models = (data && data.models) ? data.models : [];
      render(models);
      window.appletAPI.setAppletState({ models: models });
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>';
    }
  })();
})();
