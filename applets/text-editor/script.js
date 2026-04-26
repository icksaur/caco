var currentFilePath = '';
var originalContent = '';
var isDirty = false;
var editorView = null;
var cmReady = false;

var saveBtn = document.getElementById('saveBtn');
var statusEl = document.getElementById('status');
var filePathEl = document.getElementById('filePath');
var folderBtn = document.getElementById('folderBtn');
var viewLink = document.getElementById('viewLink');
var editorArea = document.getElementById('editorArea');

function loadCMBundle() {
  return new Promise(function(resolve, reject) {
    if (window.CM) { resolve(); return; }
    var s = document.createElement('script');
    s.src = '/api/applets/text-editor/assets/codemirror-bundle.js?v=2';
    s.onload = function() { resolve(); };
    s.onerror = function() { reject(new Error('Failed to load CodeMirror')); };
    document.head.appendChild(s);
  });
}

var viewerMap = {
  md: 'markdown-viewer', mdx: 'markdown-viewer', markdown: 'markdown-viewer',
  png: 'image-viewer', jpg: 'image-viewer', jpeg: 'image-viewer',
  gif: 'image-viewer', webp: 'image-viewer', svg: 'image-viewer',
};

var extToLang = {
  js: 'javascript', ts: 'javascript', jsx: 'javascript', tsx: 'javascript',
  json: 'json', md: 'markdown', xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', ps1: 'powershell', psm1: 'powershell',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  glsl: 'glsl', vert: 'glsl', frag: 'glsl',
  cmake: 'cmake', makefile: 'cmake',
};

function getLanguageExt(path) {
  if (!path) return '';
  var basename = path.split('/').pop().toLowerCase();
  if (basename === 'makefile' || basename === 'cmakelists.txt') return 'cmake';
  return extToLang[path.split('.').pop().toLowerCase()] || '';
}

function getLanguageExtension(langKey) {
  if (!langKey || !CM) return [];
  switch (langKey) {
    case 'javascript': return [CM.javascript({ typescript: true, jsx: true })];
    case 'json': return [CM.json()];
    case 'markdown': return [CM.markdown()];
    case 'xml': return [CM.xml()];
    case 'cpp': return [CM.cpp()];
    case 'css': return [CM.css()];
    case 'csharp': return [new CM.LanguageSupport(CM.StreamLanguage.define(CM.csharp))];
    case 'powershell': return [new CM.LanguageSupport(CM.StreamLanguage.define(CM.powerShell))];
    case 'shell': return [new CM.LanguageSupport(CM.StreamLanguage.define(CM.shell))];
    case 'cmake': return [new CM.LanguageSupport(CM.StreamLanguage.define(CM.cmake))];
    case 'glsl': return [new CM.LanguageSupport(CM.StreamLanguage.define(CM.glsl))];
    default: return [];
  }
}

var cacoTheme = null;

function ensureTheme() {
  if (cacoTheme) return cacoTheme;
  var isDark = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().match(/^#([0-9a-f]{2})/i);
  var dark = isDark ? parseInt(isDark[1], 16) < 128 : true;

  var highlightStyle = CM.HighlightStyle.define([
    { tag: CM.tags.keyword, color: 'var(--color-purple, #c678dd)' },
    { tag: [CM.tags.name, CM.tags.deleted, CM.tags.character, CM.tags.macroName], color: 'var(--color-red, #e06c75)' },
    { tag: [CM.tags.function(CM.tags.variableName), CM.tags.labelName], color: 'var(--color-accent, #61afef)' },
    { tag: [CM.tags.color, CM.tags.constant(CM.tags.name), CM.tags.standard(CM.tags.name)], color: 'var(--color-orange, #d19a66)' },
    { tag: [CM.tags.definition(CM.tags.name), CM.tags.separator], color: 'var(--color-text, #abb2bf)' },
    { tag: [CM.tags.typeName, CM.tags.className, CM.tags.number, CM.tags.changed, CM.tags.annotation, CM.tags.modifier, CM.tags.self, CM.tags.namespace], color: 'var(--color-yellow, #e5c07b)' },
    { tag: [CM.tags.string, CM.tags.special(CM.tags.brace)], color: 'var(--color-green, #98c379)' },
    { tag: [CM.tags.regexp, CM.tags.escape, CM.tags.special(CM.tags.string)], color: 'var(--color-cyan, #56b6c2)' },
    { tag: CM.tags.comment, color: 'var(--color-text-dim, #5c6370)', fontStyle: 'italic' },
    { tag: CM.tags.meta, color: 'var(--color-text-muted, #7f848e)' },
    { tag: CM.tags.strong, fontWeight: 'bold' },
    { tag: CM.tags.emphasis, fontStyle: 'italic' },
    { tag: CM.tags.link, color: 'var(--color-accent, #61afef)', textDecoration: 'underline' },
    { tag: CM.tags.heading, fontWeight: 'bold', color: 'var(--color-red, #e06c75)' },
    { tag: CM.tags.atom, color: 'var(--color-orange, #d19a66)' },
    { tag: CM.tags.bool, color: 'var(--color-orange, #d19a66)' },
    { tag: CM.tags.processingInstruction, color: 'var(--color-text-muted, #7f848e)' },
  ]);

  cacoTheme = [
    CM.EditorView.theme({
      '&': {
        backgroundColor: 'var(--bg-base)',
        color: 'var(--color-text)',
        fontSize: '11pt',
        height: '100%',
      },
      '.cm-content': {
        fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
        padding: '12px 0',
        caretColor: 'var(--color-text-bright)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-base)',
        borderRight: '1px solid var(--color-border)',
        color: 'var(--color-text-dim)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--bg-raised)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--bg-raised)' },
      '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--color-text-bright)' },
      '.cm-cursor': { borderLeftColor: 'var(--color-text-bright)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(100, 149, 237, 0.3) !important',
      },
      '.cm-scroller': { overflow: 'auto' },
    }, { dark: dark }),
    CM.syntaxHighlighting(highlightStyle),
  ];
  return cacoTheme;
}

function createEditor(content, langKey) {
  if (editorView) editorView.destroy();

  var langExts = getLanguageExtension(langKey);
  var extensions = [
    CM.history(),
    CM.bracketMatching(),
    CM.indentOnInput(),
    CM.highlightActiveLine(),
    CM.keymap.of([
      ...CM.defaultKeymap,
      ...CM.historyKeymap,
      CM.indentWithTab,
      { key: 'Mod-s', run: function() { if (!saveBtn.disabled) saveBtn.click(); return true; } },
      { key: 'Mod-p', run: function() { openFinder(); return true; } },
    ]),
    ...ensureTheme(),
    CM.EditorView.updateListener.of(function(update) {
      if (update.docChanged) {
        var text = update.state.doc.toString();
        isDirty = text !== originalContent;
        saveBtn.disabled = !isDirty;
        saveBtn.textContent = isDirty ? 'Save *' : 'Save';
        saveBtn.classList.toggle('dirty', isDirty);
      }
    }),
    ...langExts,
  ];

  editorView = new CM.EditorView({
    state: CM.EditorState.create({ doc: content, extensions: extensions }),
    parent: editorArea,
  });
}

function openFinder() {
  if (!currentFilePath) return;
  var dir = currentFilePath.split('/').slice(0, -1).join('/');
  window.location.href = '/?applet=file-finder&root=' + encodeURIComponent(dir);
}

function updateHeader(path) {
  if (!path) {
    filePathEl.textContent = 'No file loaded';
    filePathEl.removeAttribute('href');
    filePathEl.style.cursor = '';
    folderBtn.style.display = 'none';
    viewLink.style.display = 'none';
    return;
  }

  var basename = path.split('/').pop();
  filePathEl.textContent = basename;
  filePathEl.title = path;
  folderBtn.style.display = '';

  var ext = basename.split('.').pop().toLowerCase();
  var viewer = viewerMap[ext];
  if (viewer) {
    var viewerUrl = '/?applet=' + viewer + '&path=' + encodeURIComponent(path);
    filePathEl.style.cursor = 'pointer';
    filePathEl.onclick = function() { window.location.href = viewerUrl; };
    viewLink.href = viewerUrl;
    viewLink.style.display = '';
  } else {
    filePathEl.style.cursor = '';
    filePathEl.onclick = null;
    viewLink.style.display = 'none';
  }
}

async function loadFile(path) {
  if (!path) {
    updateHeader('');
    if (cmReady) createEditor('', '');
    return;
  }

  if (!cmReady) {
    statusEl.textContent = 'Loading editor...';
    try {
      await loadCMBundle();
      cmReady = true;
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'status error';
      return;
    }
  }

  updateHeader(path);
  statusEl.textContent = 'Loading...';
  statusEl.className = 'status';
  var langKey = getLanguageExt(path);

  try {
    var response = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var text = await response.text();
    originalContent = text;
    isDirty = false;
    saveBtn.disabled = true;
    saveBtn.classList.remove('dirty');
    saveBtn.textContent = 'Save';
    createEditor(text, langKey);
    statusEl.textContent = text.length + ' chars' + (langKey ? ' • ' + langKey : '');

    window.appletAPI.setAppletState({ path: path, loaded: true, size: text.length, language: langKey });
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'status error';
  }
}

saveBtn.addEventListener('click', async function() {
  if (!currentFilePath || !isDirty || !editorView) return;

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.className = 'status';

  try {
    var text = editorView.state.doc.toString();
    var response = await fetch('/api/files/' + encodeURIComponent(currentFilePath), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });

    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || 'Save failed');
    }

    originalContent = text;
    isDirty = false;
    saveBtn.textContent = 'Save';
    saveBtn.classList.remove('dirty');
    statusEl.textContent = 'Saved!';
    statusEl.className = 'status success';

    setTimeout(function() {
      statusEl.textContent = text.length + ' chars';
      statusEl.className = 'status';
    }, 2000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'status error';
    saveBtn.disabled = false;
  }
});

folderBtn.addEventListener('click', openFinder);

window.appletAPI.onUrlParamsChange(function(params) {
  var newPath = params.path || '';
  if (newPath !== currentFilePath) {
    currentFilePath = newPath;
    loadFile(currentFilePath);
  }
});
