/**
 * oEmbed Module
 * 
 * Fetches embed HTML from various media providers using the oEmbed protocol.
 * Supports YouTube, SoundCloud, Vimeo, Spotify, and more.
 */

interface ProviderConfig {
  patterns: RegExp[];
  endpoint: string;
  name: string;
}

interface DetectedProvider extends ProviderConfig {
  key: string;
}

interface OEmbedOptions {
  maxwidth?: string | number;
  maxheight?: string | number;
}

interface OEmbedResult {
  provider: string;
  providerKey: string;
  title: string;
  author: string;
  html: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  type: string;
}

interface ProviderInfo {
  key: string;
  name: string;
  examples: string[];
}

// Provider configurations with their oEmbed endpoints
const PROVIDERS: Record<string, ProviderConfig> = {
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
 */
export function detectProvider(url: string): DetectedProvider | null {
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
 */
export async function fetchOEmbed(url: string, options: OEmbedOptions = {}): Promise<OEmbedResult> {
  const provider = detectProvider(url);
  if (!provider) {
    throw new Error(`Unsupported URL: ${url}`);
  }
  
  // Build oEmbed request URL
  const params = new URLSearchParams({
    url,
    format: 'json',
    maxwidth: String(options.maxwidth || '640'),
    maxheight: String(options.maxheight || '360')
  });
  
  const oembedUrl = `${provider.endpoint}?${params.toString()}`;
  
  const response = await fetch(oembedUrl);
  if (!response.ok) {
    throw new Error(`oEmbed request failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json() as Record<string, unknown>;
  
  return {
    provider: provider.name,
    providerKey: provider.key,
    title: (data.title as string) || '',
    author: (data.author_name as string) || '',
    html: (data.html as string) || '',
    thumbnailUrl: (data.thumbnail_url as string) || '',
    width: data.width as number | undefined,
    height: data.height as number | undefined,
    type: (data.type as string) || 'rich'
  };
}

/**
 * Get list of supported providers for documentation
 */
export function getSupportedProviders(): ProviderInfo[] {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name,
    examples: p.patterns.map(r => r.source)
  }));
}
