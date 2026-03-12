var themes = [
  { id: 'dark', name: 'Dark', description: 'Default dark theme' },
  { id: 'light', name: 'Light', description: 'Clean light theme' },
  { id: 'solarized-dark', name: 'Solarized Dark', description: 'Solarized color scheme' }
];

var STORAGE_KEY = 'caco:theme';
var LINK_ID = 'cacoThemeLink';

function getCurrentTheme() {
  return localStorage.getItem(STORAGE_KEY) || 'dark';
}

function applyTheme(themeId) {
  var existing = document.getElementById(LINK_ID);
  if (themeId === 'dark') {
    if (existing) existing.remove();
  } else {
    if (!existing) {
      existing = document.createElement('link');
      existing.id = LINK_ID;
      existing.rel = 'stylesheet';
      document.head.appendChild(existing);
    }
    existing.href = '/themes/' + themeId + '.css';
  }
  localStorage.setItem(STORAGE_KEY, themeId);
  render();
  window.appletAPI.setAppletState({ theme: themeId });
}

function render() {
  var current = getCurrentTheme();
  var list = document.getElementById('themeList');
  var html = '';
  for (var i = 0; i < themes.length; i++) {
    var t = themes[i];
    var active = t.id === current ? ' active' : '';
    html += '<div class="theme-item' + active + '" data-id="' + t.id + '">';
    html += '<span class="theme-name">' + t.name + '</span>';
    html += '<span class="theme-desc">' + t.description + '</span>';
    if (t.id === current) html += '<span class="theme-check">✓</span>';
    html += '</div>';
  }
  list.innerHTML = html;
  list.querySelectorAll('.theme-item').forEach(function(el) {
    el.addEventListener('click', function() {
      applyTheme(this.getAttribute('data-id'));
    });
  });
}

render();
