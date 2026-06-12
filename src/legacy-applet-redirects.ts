/**
 * Server-side redirect helper for legacy applet slugs.
 *
 * Pure function: takes slug + current query params, returns new
 * URLSearchParams to redirect to, or null when no redirect is needed.
 *
 * Rules (spec §4.7):
 *   markdown-viewer / image-viewer / html-viewer  + path  → files + openPath
 *   file-finder + root → files + openFinder=1 + openFinderRoot
 *   file-finder (no root) → files
 *   git-diff + file → files + openPath + diffMode
 *   git-diff + ref (no file) → git-status (+ forward path if present)
 *   all other params preserved; only applet + translated source params mutated.
 *   returns null for non-legacy slugs and no-op cases (e.g. applet=files).
 */

const VIEWER_SLUGS = new Set(['markdown-viewer', 'image-viewer', 'html-viewer']);

export function legacyAppletRedirectTarget(
  slug: string,
  params: URLSearchParams
): URLSearchParams | null {
  if (VIEWER_SLUGS.has(slug)) {
    const path = params.get('path');
    if (!path) return null;
    const out = new URLSearchParams(params);
    out.set('applet', 'files');
    out.set('openPath', path);
    out.delete('path');
    return out;
  }

  if (slug === 'file-finder') {
    const root = params.get('root');
    const out = new URLSearchParams(params);
    out.set('applet', 'files');
    out.delete('root');
    if (root) {
      out.set('openFinder', '1');
      out.set('openFinderRoot', root);
    }
    return out;
  }

  if (slug === 'git-diff') {
    const file = params.get('file');
    if (file) {
      const staged = params.get('staged');
      const out = new URLSearchParams(params);
      out.set('applet', 'files');
      out.set('openPath', file);
      out.set('diffMode', staged === '1' ? 'staged' : 'unstaged');
      out.delete('file');
      out.delete('staged');
      return out;
    }
    const ref = params.get('ref');
    if (ref) {
      const out = new URLSearchParams(params);
      out.set('applet', 'git-status');
      out.delete('ref');
      return out;
    }
    return null;
  }

  return null;
}
