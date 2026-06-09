/**
 * Main entry point - ties all modules together
 */

import { setupImagePaste, removeImage } from './image-paste.js';
import { scrollToBottom } from './ui-utils.js';
import { loadPreferences } from './history.js';
import { archiveSession, initSessionPanel, loadSessions, loadSchedules, getCachedSessions } from './session-panel.js';
import { selectModel, loadModels } from './model-selector.js';
import { initMessageStreaming, stopStreaming } from './message-streaming.js';
import { setupMarkdownRenderer } from './markdown-renderer.js';
import { initRegions } from './dom-regions.js';
import { initViewState, setViewState, showSessionPanel } from './view-controller.js';
import { initAppletRuntime, loadAppletFromUrl } from './applet-runtime.js';
import { initInputRouter } from './input-router.js';
import { registerPoundProvider } from './multiline-input.js';
import { ChatFormController } from './chat-form-controller.js';
import { chatView } from './chat-view-controller.js';
import { connectWs, waitForConnect, reconnectIfNeeded } from './websocket.js';
import { hideToast } from './toast.js';
import { initHostnameHash } from './hostname-hash.js';
import { initRouter, toggleSessions, toggleApplet, sessionClick } from './router.js';
import { registerCommand } from './command-registry.js';
import { initPanelResizer } from './panel-resizer.js';
import { initNotifications } from './notifications.js';
import { loadClientExtensions, reloadExtension } from './extension-loader.js';
import { onGlobalEvent } from './websocket.js';
import { adHocBar } from './adhoc-bar.js';
import { setupSwarmProgress } from './swarm-progress.js';
import { initUsageDisplays, refreshUsageDisplays } from './usage-display.js';
import { getPanelState } from './panel-state.js';
import { bindPanelStateToDom, readPanelStateFromDom } from './panel-dom-binder.js';

declare global {
  interface Window {
    removeImage: typeof removeImage;
    scrollToBottom: typeof scrollToBottom;
    toggleSessions: typeof toggleSessions;
    archiveSession: typeof archiveSession;
    selectModel: typeof selectModel;
    loadModels: typeof loadModels;
    stopStreaming: typeof stopStreaming;
    toggleApplet: typeof toggleApplet;
    hideToast: typeof hideToast;
  }
}

window.removeImage = removeImage;
window.scrollToBottom = scrollToBottom;
window.toggleSessions = toggleSessions;
window.archiveSession = archiveSession;
window.selectModel = selectModel;
window.loadModels = loadModels;
window.stopStreaming = stopStreaming;
window.toggleApplet = toggleApplet;
window.hideToast = hideToast;

// LIFECYCLE: prompt-template registrations. Each call replaces the
// prior batch entirely — disposers from the last load are run before
// the new fetch. Lets us hot-reload templates without leaking
// orphan slash commands when a template is server-side deleted.
const promptTemplateDisposers: Array<() => void> = [];

async function loadPromptTemplates(): Promise<void> {
  for (const dispose of promptTemplateDisposers.splice(0)) {
    try { dispose(); } catch { /* ignore */ }
  }
  try {
    const promptResp = await fetch('/api/prompts');
    if (!promptResp.ok) return;
    const { prompts } = await promptResp.json();
    for (const p of prompts) {
      const dispose = registerCommand({
        name: p.name,
        description: p.description,
        source: 'template',
        handler: async () => {
          const resp = await fetch(`/api/prompts/${encodeURIComponent(p.name)}`);
          if (!resp.ok) return;
          const { content } = await resp.json();
          const textarea = chatView.getActiveForm()?.textarea;
          if (textarea) {
            textarea.value = content;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      });
      promptTemplateDisposers.push(dispose);
    }
  } catch (e) {
    console.warn('Failed to load prompt templates:', e);
  }
}

// Wrap async init in void to satisfy eslint no-misused-promises
document.addEventListener('DOMContentLoaded', () => {
  // Load saved theme before rendering
  const savedTheme = localStorage.getItem('caco:theme');
  if (savedTheme) {
    const link = document.createElement('link');
    link.id = 'cacoThemeLink';
    link.rel = 'stylesheet';
    link.href = `/themes/${savedTheme}.css`;
    document.head.appendChild(link);
  }

  void (async () => {
    // Initialize DOM region registry (must be first — other modules access regions)
    initRegions();
    
    // Initialize view state from DOM
    initViewState();

    // Wire the panel state store: read current DOM into the store, then
    // bind so any future store changes flow back to the DOM. During step 1
    // of the panel-state refactor this is dormant — legacy view-controller
    // show/hide functions still touch the DOM directly.
    const panelStore = getPanelState();
    panelStore.set(readPanelStateFromDom(), 'init');
    bindPanelStateToDom(panelStore);
    
    // Initialize router (Navigation API handler)
    initRouter();
    
    // Initialize input router (global keyboard event routing)
    initInputRouter();
    
    // Initialize applet runtime (exposes setAppletState globally)
    initAppletRuntime();
    
    initPanelResizer();
    initNotifications();
    
    // Initialize session panel (subscribe to WS session state events)
    initSessionPanel();
    showSessionPanel();
    void loadSessions();
    void loadSchedules();
    initUsageDisplays();
    
    registerPoundProvider(() => {
      return getCachedSessions()
        .filter(s => s.kind !== 'swarm')
        .map(s => ({
          id: `session:${s.sessionId}`,
          label: s.name || s.summary || s.sessionId.slice(0, 8),
          description: 'session',
          value: '`caco-session:' + s.sessionId + '`',
        }));
    });
    
    // Connect WebSocket — MUST run AFTER initMessageStreaming()
    // registers the WS event handlers AND AFTER chattingForm.attach()
    // installs the sessionTracker.onChange listener that pushes
    // sessionBusy into formStateStore; otherwise the first WS event
    // can arrive before handlers are wired or before the busy state
    // pump is active. Moved here from pre-attach in R3.5 Step 3.4.
  
  // Reconnect WS when page becomes visible (e.g., returning from another tab)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnectIfNeeded();
      void refreshUsageDisplays();
    }
  });
  
  // Additional reconnection triggers for laptop sleep/lock scenarios (Windows compatibility)
  window.addEventListener('focus', () => {
    reconnectIfNeeded();
  });
  
  window.addEventListener('online', () => {
    reconnectIfNeeded();
  });
  
  // Initialize ad-hoc bar
  const adHocContainer = document.getElementById('adHocBar');
  if (adHocContainer) adHocBar.init(adHocContainer);
  setupSwarmProgress();
  
  // Set up event handlers
  setupImagePaste();
  // Per-view chat-input form controllers. Each form has its own
  // binding + debounce timer; the bleed bug is structurally
  // impossible because no two views share a textarea.
  const newChatFormEl = document.getElementById('newChatForm') as HTMLFormElement;
  const chattingFormEl = document.getElementById('chattingForm') as HTMLFormElement;
  const newChatForm = new ChatFormController(newChatFormEl, 'newChat', chatView);
  const chattingForm = new ChatFormController(chattingFormEl, 'chatting', chatView);
  chatView.bindForms({ newChat: newChatForm, chatting: chattingForm });
  // R3.5 boot order (DO NOT REORDER):
  //   1. initMessageStreaming() — registers WS handlers + chatRegion.
  //   2. chattingForm.attach() — installs the sessionTracker.onChange
  //      → formStateStore pump that drives Send/Stop button state.
  //   3. connectWs() — first WS event MUST arrive after handlers and
  //      pump are wired, or session.idle on the first event misses
  //      the formStateStore update and the Send button stays "Stop".
  initMessageStreaming();
  newChatForm.attach();
  chattingForm.attach();
  connectWs();
  await waitForConnect();
  setupMarkdownRenderer();
  
  await loadPromptTemplates();
  
  // Load extensions (CSS injection + client extensions)
  try {
    const extResp = await fetch('/api/extensions');
    if (extResp.ok) {
      const { extensions } = await extResp.json();
      for (const ext of extensions) {
        if (ext.provides.includes('css')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = `/api/extensions/${ext.slug}/style.css`;
          link.dataset.extensionSlug = ext.slug;
          document.head.appendChild(link);
        }
      }
    }
    await loadClientExtensions();
  } catch (e) {
    console.warn('Failed to load extensions:', e);
  }
  
  // Extension hot-reload handlers
  onGlobalEvent((event) => {
    if (event.type === 'extension.cssChanged') {
      const slug = (event.data as { slug: string })?.slug;
      const link = document.querySelector(`link[data-extension-slug="${slug}"]`) as HTMLLinkElement;
      if (link) link.href = `/api/extensions/${slug}/style.css?t=${Date.now()}`;
    } else if (event.type === 'extension.reload') {
      const slug = (event.data as { slug: string })?.slug;
      if (slug) void reloadExtension(slug);
    }
  });
  
  // Cross-iframe navigation: portal sends caco:navigateSession to switch sessions
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'caco:navigateSession' && e.data.sessionId) {
      void sessionClick(e.data.sessionId);
    }
  });

  // Initialize hostname-based favicon and button colors
  initHostnameHash();
  
  // Fetch models once on page load
  try {
    const response = await fetch('/api/sessions');
    if (response.ok) {
      const data = await response.json();
      if (data.models && data.models.length > 0) {
        const { setAvailableModels } = await import('./model-selector.js');
        setAvailableModels(data.models);
      }
    }
  } catch (e) {
    console.error('Failed to fetch models on startup:', e);
  }
  
  // Load preferences to check for active session
  const prefs = await loadPreferences();
  
  // Check URL params
  const urlParams = new URLSearchParams(window.location.search);
  const hasAppletParam = urlParams.has('applet');
  const sessionParam = urlParams.get('session');
  
  // Determine which session to load: URL param takes priority over preferences
  const targetSessionId = sessionParam || prefs?.lastSessionId;
  
  if (targetSessionId) {
    const { chatView } = await import('./chat-view-controller.js');
    await chatView.activateSession(targetSessionId);
    
    // Load applet if requested (orthogonal to main panel)
    if (hasAppletParam) {
      await loadAppletFromUrl();
    }
  } else {
    // No session specified - show new chat as default
    setViewState('newChat');
    loadModels();
    
    // Load applet if requested (orthogonal to main panel)
    if (hasAppletParam) {
      await loadAppletFromUrl();
    }
  }
  })();
});
