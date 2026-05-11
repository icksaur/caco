var searchInput = document.getElementById('searchInput');
var searchBtn = document.getElementById('searchBtn');
var resultsEl = document.getElementById('results');

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function highlightSnippet(snippet, matchStart, matchEnd) {
  var before = esc(snippet.slice(0, matchStart));
  var match = esc(snippet.slice(matchStart, matchEnd));
  var after = esc(snippet.slice(matchEnd));
  return before + '<mark>' + match + '</mark>' + after;
}

async function doSearch() {
  var query = searchInput.value.trim();
  if (!query) return;

  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching...';
  resultsEl.innerHTML = '<div class="searching">Searching sessions...</div>';

  try {
    var res = await fetch('/api/sessions/search?q=' + encodeURIComponent(query));
    var data = await res.json();
    renderResults(data.results || [], query);
  } catch (err) {
    resultsEl.innerHTML = '<div class="error">Search failed: ' + esc(err.message) + '</div>';
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '🔍 Search';
  }
}

function renderResults(results, query) {
  if (results.length === 0) {
    resultsEl.innerHTML = '<div class="no-results">No matches found for "' + esc(query) + '"</div>';
    return;
  }

  var html = '<div class="result-count">' + results.length + ' session' + (results.length !== 1 ? 's' : '') + ' matched</div>';

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    html += '<div class="result-card">';
    html += '<div class="result-header">';
    html += '<a class="result-name" href="/?session=' + r.sessionId + '">' + esc(r.name) + '</a>';
    html += '<span class="result-count-badge">' + r.matchCount + ' match' + (r.matchCount !== 1 ? 'es' : '') + '</span>';
    html += '</div>';
    html += '<div class="result-id">caco-session:' + r.sessionId + '</div>';

    for (var j = 0; j < r.matches.length; j++) {
      var m = r.matches[j];
      html += '<div class="result-snippet">';
      html += '<span class="snippet-type">' + (m.eventType === 'user.message' ? 'user' : m.eventType === 'note' ? 'note' : m.eventType === 'roadmap' ? 'roadmap' : 'assistant') + '</span> ';
      html += highlightSnippet(m.snippet, m.matchStart, m.matchEnd);
      html += '</div>';
    }

    html += '</div>';
  }

  resultsEl.innerHTML = html;
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSearch();
});

searchInput.focus();

var params = new URLSearchParams(window.location.search);
var initialQuery = params.get('q');
if (initialQuery) {
  searchInput.value = initialQuery;
  doSearch();
}
