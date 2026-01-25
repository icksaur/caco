/**
 * oEmbed Module
 * 
 * Fetches embed HTML from various media providers using the oEmbed protocol.
 * Supports YouTube, SoundCloud, Vimeo, Spotify, and more.
 */

// Provider configurations with their oEmbed endpoints
const PROVIDERS = {
  youtube: {
    patterns: [
      /youtube\.com\/watch\?v=[\w-]+/,
      /youtu\.be\/[\w-]+/,
      /youtube\.com\/embed\/[\w-]+/,
      /youtube\.com\/shorts\/[\w-]+/
    ],
    endpoint: 'https://www.youtube.com/oembed',
    name: 'YouTube'
  },
  soundcloud: {
    patterns: [
      /soundcloud\.com\/[\w-]+\/[\w-]+/
    ],
    endpoint: 'https://soundcloud.com/oembed',
    name: 'SoundCloud'
  },
  vimeo: {
    patterns: [
      /vimeo\.com\/\d+/,
      /player\.vimeo\.com\/video\/\d+/
    ],
    endpoint: 'https://vimeo.com/api/oembed.json',
    name: 'Vimeo'
  },
  spotify: {
    patterns: [
      /open\.spotify\.com\/(track|album|playlist|episode|show)\/[\w]+/
    ],
    endpoint: 'https://open.spotify.com/oembed',
    name: 'Spotify'
  },
  twitter: {
    patterns: [
      /twitter\.com\/\w+\/status\/\d+/,
      /x\.com\/\w+\/status\/\d+/
    ],
    endpoint: 'https://publish.twitter.com/oembed',
    name: 'Twitter/X'
  }
};

/**
 * Detect which provider a URL belongs to
 * @param {string} url - Media URL
 * @returns {Object|null} Provider config or null
 */
export function detectProvider(url) {
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    for (const pattern of provider.patterns) {
      if (pattern.test(url)) {
        return { key, ...provider };
      }
    }
  }
  return null;
}

/**
 * Fetch oEmbed data for a URL
 * @param {string} url - Media URL
 * @param {Object} options - Options like maxwidth, maxheight
 * @returns {Promise<Object>} oEmbed response with html, title, etc.
 */
export async function fetchOEmbed(url, options = {}) {
  const provider = detectProvider(url);
  if (!provider) {
    throw new Error(`Unsupported URL: ${url}`);
  }
  
  // Build oEmbed request URL
  const params = new URLSearchParams({
    url,
    format: 'json',
    maxwidth: options.maxwidth || '640',
    maxheight: options.maxheight || '360'
  });
  
  const oembedUrl = `${provider.endpoint}?${params.toString()}`;
  
  const response = await fetch(oembedUrl);
  if (!response.ok) {
    throw new Error(`oEmbed request failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    provider: provider.name,
    providerKey: provider.key,
    title: data.title || '',
    author: data.author_name || '',
    html: data.html || '',
    thumbnailUrl: data.thumbnail_url || '',
    width: data.width,
    height: data.height,
    type: data.type // 'video', 'rich', 'photo', 'link'
  };
}

/**
 * Get list of supported providers for documentation
 */
export function getSupportedProviders() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name,
    examples: p.patterns.map(r => r.source)
  }));
}
