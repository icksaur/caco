/**
 * Panel DOM Binder
 *
 * Reflects panel state into the DOM. The ONLY module allowed to add or
 * remove `.hidden` on #sessionView and #appletPanel during the refactor.
 *
 * Step 1 (current): subscribes to the store but the store has no writers
 * other than itself yet, so this is dormant. Once writers move to the
 * store in step 2, this becomes the sole DOM writer.
 */

import type { PanelState, PanelStateStore } from './panel-state.js';
import { regions } from './dom-regions.js';

/**
 * Read current DOM state — used to initialize the store so it inherits
 * whatever the legacy code already established before bind time.
 */
export function readPanelStateFromDom(): PanelState {
  return {
    session: !document.getElementById('sessionView')?.classList.contains('hidden'),
    applet: !document.getElementById('appletPanel')?.classList.contains('hidden'),
  };
}

/**
 * Bind a store to the DOM. Returns the unsubscribe function.
 *
 * On every store change, reflects state into `.hidden` classes and the
 * companion `.active` classes on the toggle buttons. Idempotent: writes
 * are conditional on a real change to that class.
 */
export function bindPanelStateToDom(store: PanelStateStore): () => void {
  const apply = (state: PanelState): void => {
    void regions; // ensure dom-regions has been initialized; binder reads ids directly

    const sessionView = document.getElementById('sessionView');
    const menuBtn = document.getElementById('menuBtn');
    const appletPanel = document.getElementById('appletPanel');
    const appletBtn = document.getElementById('appletBtn');
    const expandBtn = document.getElementById('expandBtn');

    if (sessionView) {
      sessionView.classList.toggle('hidden', !state.session);
    }
    if (menuBtn) {
      menuBtn.classList.toggle('active', state.session);
    }
    if (appletPanel) {
      appletPanel.classList.toggle('hidden', !state.applet);
    }
    if (appletBtn) {
      appletBtn.classList.toggle('active', state.applet);
    }
    if (expandBtn) {
      expandBtn.classList.toggle('hidden', !state.applet);
    }
  };

  // Sync once on bind so the DOM matches the store's current value
  // (legacy code may have established initial state before us).
  apply(store.get());

  return store.subscribe((next) => apply(next));
}
