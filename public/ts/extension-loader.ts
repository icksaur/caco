/**
 * Extension Loader
 *
 * Dynamically imports client extensions from /api/extensions/:slug/client.js
 * and initializes them with a ClientExtensionAPI instance.
 */

import { createExtensionAPI } from './extension-api.js';
import { showToast } from './toast.js';

interface ExtensionInfo {
  slug: string;
  provides: string[];
}

const disposeFns = new Map<string, () => void>();

export async function loadClientExtensions(): Promise<void> {
  let extensions: ExtensionInfo[];
  try {
    const resp = await fetch('/api/extensions');
    if (!resp.ok) return;
    const data = await resp.json();
    extensions = data.extensions;
  } catch {
    return;
  }

  for (const ext of extensions) {
    if (ext.provides.includes('client')) {
      await loadOne(ext.slug);
    }
  }
}

async function loadOne(slug: string, cacheBust?: string): Promise<void> {
  try {
    const url = cacheBust
      ? `/api/extensions/${slug}/client.js?t=${cacheBust}`
      : `/api/extensions/${slug}/client.js`;
    const mod = await import(url);
    if (typeof mod.default !== 'function') {
      console.warn(`[EXT:${slug}] client.js has no default export`);
      return;
    }
    const api = createExtensionAPI(slug);
    const dispose = mod.default(api);
    if (typeof dispose === 'function') {
      disposeFns.set(slug, dispose);
    }
  } catch (err) {
    console.error(`[EXT:${slug}]`, err);
    showToast(`Extension "${slug}" failed to load`);
  }
}

export async function reloadExtension(slug: string): Promise<void> {
  const oldDispose = disposeFns.get(slug);
  if (oldDispose) {
    try { oldDispose(); } catch (err) { console.error(`[EXT:${slug}] dispose error:`, err); }
    disposeFns.delete(slug);
  }
  await loadOne(slug, Date.now().toString());
}
