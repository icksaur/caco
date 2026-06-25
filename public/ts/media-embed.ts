/**
 * Whitelisted media-URL → iframe-src mapping. The exact-host allowlist is the
 * trust boundary: a URL is embeddable only if its hostname matches a known host
 * EXACTLY (no suffix match, so `youtube.com.evil.com` is rejected) and an id can
 * be extracted into a FIXED per-provider template. Nothing from the input URL
 * other than the validated id/type reaches the output `src`. Anything else
 * returns null and the caller renders a plain link.
 *
 * Pure and dependency-free so it is unit-testable by an independent reference
 * table (see tests/unit/media-embed.test.ts).
 */

export type MediaKind = 'youtube' | 'vimeo' | 'spotify';

export interface MediaEmbed {
  kind: MediaKind;
  src: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const VIMEO_ID = /^[0-9]{1,32}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{1,40}$/;
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);

function youtubeSrc(u: URL): string | null {
  let id: string | null = null;
  if (u.hostname === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] ?? null;
  } else {
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] === 'watch') id = u.searchParams.get('v');
    else if (segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live') id = segs[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

function vimeoSrc(u: URL): string | null {
  const segs = u.pathname.split('/').filter(Boolean);
  const id = u.hostname === 'player.vimeo.com'
    ? (segs[0] === 'video' ? segs[1] : undefined)
    : segs[0];
  return id && VIMEO_ID.test(id) ? `https://player.vimeo.com/video/${id}` : null;
}

function spotifySrc(u: URL): string | null {
  const segs = u.pathname.split('/').filter(Boolean);
  const [type, id] = segs[0] === 'embed' ? [segs[1], segs[2]] : [segs[0], segs[1]];
  return type && id && SPOTIFY_TYPES.has(type) && SPOTIFY_ID.test(id)
    ? `https://open.spotify.com/embed/${type}/${id}`
    : null;
}

/**
 * Map a media URL to a fixed-template iframe src, or null if not embeddable.
 * Never throws.
 */
export function mediaEmbed(raw: string): MediaEmbed | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  if (YOUTUBE_HOSTS.has(u.hostname)) {
    const src = youtubeSrc(u);
    return src ? { kind: 'youtube', src } : null;
  }
  if (VIMEO_HOSTS.has(u.hostname)) {
    const src = vimeoSrc(u);
    return src ? { kind: 'vimeo', src } : null;
  }
  if (SPOTIFY_HOSTS.has(u.hostname)) {
    const src = spotifySrc(u);
    return src ? { kind: 'spotify', src } : null;
  }
  return null;
}
