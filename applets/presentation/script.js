var sessionId = null;
var presentation = null;
var currentSlide = 0;

var titleEl = document.getElementById('title');
var slideContainer = document.getElementById('slideContainer');
var slideContent = document.getElementById('slideContent');
var prevBtn = document.getElementById('prevBtn');
var nextBtn = document.getElementById('nextBtn');
var slideCounter = document.getElementById('slideCounter');
var nav = document.getElementById('nav');
var empty = document.getElementById('empty');

function esc(s) { return appletAPI.escapeHtml(s); }

async function loadPresentation() {
  if (!sessionId) return;
  try {
    var res = await fetch('/api/sessions/' + sessionId + '/presentation');
    var data = await res.json();
    if (data.slides && data.slides.length) {
      presentation = data;
      if (currentSlide >= presentation.slides.length) currentSlide = 0;
      empty.style.display = 'none';
      slideContainer.style.display = '';
      nav.style.display = '';
      render();
    } else {
      presentation = null;
      showEmpty();
    }
    window.appletAPI.setAppletState({
      hasPresentation: !!presentation,
      slideCount: presentation ? presentation.slides.length : 0,
      currentSlide: currentSlide
    });
  } catch (e) {
    empty.textContent = 'Error loading presentation: ' + (e.message || e);
    showEmpty();
  }
}

function showEmpty() {
  slideContainer.style.display = 'none';
  nav.style.display = 'none';
  titleEl.textContent = '';
  empty.style.display = '';
}

function render() {
  if (!presentation || !presentation.slides.length) { showEmpty(); return; }

  titleEl.textContent = presentation.title || '';

  var md = presentation.slides[currentSlide] || '';
  slideContent.textContent = md;
  window.renderMarkdownElement(slideContent);

  // Highlight code blocks
  if (typeof hljs !== 'undefined') {
    slideContent.querySelectorAll('pre code').forEach(function(block) {
      hljs.highlightElement(block);
    });
  }

  slideCounter.textContent = (currentSlide + 1) + ' / ' + presentation.slides.length;
  prevBtn.disabled = currentSlide === 0;
  nextBtn.disabled = currentSlide >= presentation.slides.length - 1;
}

function prev() {
  if (!presentation || currentSlide <= 0) return;
  currentSlide--;
  render();
  window.appletAPI.setAppletState({ currentSlide: currentSlide });
}

function next() {
  if (!presentation || currentSlide >= presentation.slides.length - 1) return;
  currentSlide++;
  render();
  window.appletAPI.setAppletState({ currentSlide: currentSlide });
}

prevBtn.addEventListener('click', prev);
nextBtn.addEventListener('click', next);

document.addEventListener('keydown', function(e) {
  if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
});

window.appletAPI.onSessionChange(function(_id, info) {
  sessionId = info.sessionId;
  currentSlide = 0;
  loadPresentation();
});

window.appletAPI.onSessionEvent(function(event) {
  if (event.type === 'session.idle') loadPresentation();
  if (event.type === 'tool.execution_complete' && event.data) {
    if (event.data.toolName === 'update_presentation') loadPresentation();
  }
});

// Initial load
var initId = window.appletAPI.getSessionId();
if (initId) {
  sessionId = initId;
  loadPresentation();
}
