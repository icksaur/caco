/**
 * Applet Loader
 *
 * Fetches applet content from the server and hands it to the runtime to
 * render. Lives outside router.ts so chat-view-controller can import it
 * directly without creating a circular dependency via router → chatView.
 */

import { debug } from './debug.js';
import { getActiveSessionId } from './app-state.js';
import { pushApplet, type AppletContent } from './applet-runtime.js';

/**
 * Load an applet by slug.
 * Does NOT modify URL or panel visibility — caller owns both.
 */
export async function loadApplet(
  slug: string,
  urlParams?: Record<string, string>,
  options?: { restore?: boolean },
): Promise<void> {
  debug('APPLET-LOADER', `Loading: ${slug}`);

  const sessionId = getActiveSessionId();
  const response = await fetch(`/api/applets/${encodeURIComponent(slug)}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urlParams, sessionId, restore: options?.restore ?? false }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const content: AppletContent = {
    html: data.html,
    js: data.js,
    css: data.css,
    title: data.title,
  };

  pushApplet(slug, data.title || slug, content);
  debug('APPLET-LOADER', `Loaded: ${data.title || slug}`);
}
