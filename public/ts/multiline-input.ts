/**
 * Multiline Input — extension registry.
 *
 * R3.5 lifted all popup state and form-keydown handling into
 * ChatFormController + FormPopups (chat-form-popups.ts). This file
 * now exposes only the pound-completion provider registry, which is
 * cross-form by design: extensions register once and both forms'
 * pound popups see the same items.
 */

import type { PopupItem } from './input-popup.js';

/** Pound-provider registry. Both forms' FormPopups read this. */
export const poundProviders: Array<() => PopupItem[]> = [];

export function registerPoundProvider(provider: () => PopupItem[]): () => void {
  poundProviders.push(provider);
  return () => {
    const idx = poundProviders.indexOf(provider);
    if (idx >= 0) poundProviders.splice(idx, 1);
  };
}
