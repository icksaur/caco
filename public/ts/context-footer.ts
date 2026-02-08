/**
 * Context Footer
 * 
 * Displays session context (files, applet) as a persistent footer below chat.
 * Updated via WebSocket events or on session load.
 */

export interface SessionContext {
  files?: string[];
  applet?: string[];
  [key: string]: string[] | undefined;
}

/**
 * Render context footer with file links and applet.
 * Hides footer when context is empty.
 */
export function renderContextFooter(context: SessionContext): void {
  // Use data attribute to find the REAL footer, not duplicates in chat content
  const footer = document.querySelector('[data-context-footer="true"]') as HTMLElement | null;
  console.log('[CONTEXT] renderContextFooter', context, 'footer=', footer);
  if (!footer) return;
  
  const linksContainer = footer.querySelector('.context-links');
  console.log('[CONTEXT] linksContainer=', linksContainer);
  if (!linksContainer) return;
  
  const links: string[] = [];
  
  // Files - show basename only, full path in href (max 5)
  const files = context.files ?? [];
  console.log('[CONTEXT] files=', files);
  for (const path of files.slice(0, 5)) {
    // Handle both Windows (\) and Unix (/) path separators
    const name = path.split(/[\\/]/).pop() || path;
    const encodedPath = encodeURIComponent(path);
    links.push(`<a href="/?applet=text-editor&path=${encodedPath}" title="${path}">${name}</a>`);
  }
  
  // Show count if more than 5 files
  if (files.length > 5) {
    links.push(`<span class="context-more">+${files.length - 5} more</span>`);
  }
  
  // Applet - show slug with params
  const applet = context.applet;
  if (applet?.length) {
    const [slug, ...params] = applet;
    const qs = params.length ? '&' + params.join('&') : '';
    links.push(`<a href="/?applet=${slug}${qs}" class="context-applet">[${slug}]</a>`);
  }
  
  console.log('[CONTEXT] links=', links);
  
  // Hide if empty
  if (links.length === 0) {
    footer.classList.remove('has-context');
    linksContainer.innerHTML = '';
    console.log('[CONTEXT] Empty, hiding footer');
    return;
  }
  
  // Render links with separators
  linksContainer.innerHTML = links.join('<span class="context-sep">·</span>');
  footer.classList.add('has-context');
  const rect = footer.getBoundingClientRect();
  console.log('[CONTEXT] Rendered', links.length, 'links');
  console.log('[CONTEXT] Footer rect:', rect.width, 'x', rect.height, 'at', rect.top, rect.left);
}

/**
 * Clear the context footer.
 */
export function clearContextFooter(): void {
  console.log('[CONTEXT] clearContextFooter called');
  console.trace('[CONTEXT] Stack trace');
  renderContextFooter({});
}

/**
 * Handle caco.context WebSocket event.
 */
export function handleContextEvent(data: { context: SessionContext }): void {
  console.log('[CONTEXT] handleContextEvent', data);
  renderContextFooter(data.context ?? {});
}

/**
 * Capture current applet state from URL params.
 * Returns null if no applet is active.
 */
export function captureAppletState(): string[] | null {
  const params = new URLSearchParams(location.search);
  const slug = params.get('applet');
  if (!slug) return null;
  
  // First item is slug, rest are key=value params
  const items = [slug];
  params.forEach((v, k) => {
    if (k !== 'applet') items.push(`${k}=${v}`);
  });
  return items;
}

/**
 * Send captured applet context to server.
 * Fire-and-forget - accepts eventual consistency.
 */
export async function sendAppletContext(sessionId: string): Promise<void> {
  const items = captureAppletState();
  if (!items) return;
  
  try {
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setContext: { setName: 'applet', items }
      })
    });
  } catch (error) {
    // Silent failure - applet context is advisory
    console.debug('[CONTEXT] Failed to save applet context:', error);
  }
}
