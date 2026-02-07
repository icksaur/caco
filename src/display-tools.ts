/**
 * Display-Only Tools
 * 
 * Tools that display content directly to the UI and return confirmation to agent.
 * embed_media is the primary display tool - others have been removed.
 * 
 * Tools emit their own caco.* events directly via the provided emit function,
 * rather than relying on SDK event parsing. This ensures:
 * - Tool knows its own identity (no toolName parsing needed)
 * - Event emitted immediately when tool completes
 * - Clean separation of concerns
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { fetchOEmbed, detectProvider, getSupportedProviders } from './oembed.js';

// Metadata must include a type field for categorizing outputs
interface OutputMeta {
  type: 'embed';
  [key: string]: unknown;
}

type StoreOutputFn = (data: string | Buffer, metadata: OutputMeta) => string;

// Caco event for embed display - follows SDK event structure with data property
export interface CacoEmbedEvent {
  type: 'caco.embed';
  data: {
    outputId: string;
    provider: string;
    title: string;
  };
}

type EmitCacoEventFn = (event: CacoEmbedEvent) => void;

/**
 * Create display tools that use provided storeOutput and emit functions
 */
export function createDisplayTools(storeOutput: StoreOutputFn, emitCacoEvent: EmitCacoEventFn) {
  // Build provider list for tool description
  const providerList = getSupportedProviders()
    .map(p => p.name)
    .join(', ');

  const embedMedia = defineTool('embed_media', {
    description: 'Embed media (YouTube, Vimeo, SoundCloud, Spotify) inline in chat.',

    parameters: z.object({
      url: z.string().describe('URL of the media to embed (YouTube, SoundCloud, Vimeo, Spotify, Twitter/X)')
    }),

    handler: async ({ url }) => {
      try {
        // Check if URL is supported
        const provider = detectProvider(url);
        if (!provider) {
          return {
            textResultForLlm: `Unsupported media URL. Supported: ${providerList}`,
            resultType: 'error' as const
          };
        }

        // Fetch oEmbed data
        const embedData = await fetchOEmbed(url);

        // Store embed HTML for display
        const outputId = storeOutput(embedData.html, {
          type: 'embed',
          provider: embedData.provider,
          providerKey: embedData.providerKey,
          title: embedData.title,
          author: embedData.author,
          url,
          thumbnailUrl: embedData.thumbnailUrl
        });

        const info = embedData.title 
          ? `"${embedData.title}"${embedData.author ? ` by ${embedData.author}` : ''}`
          : url;

        // Emit caco.embed event directly - tool knows its own identity
        emitCacoEvent({
          type: 'caco.embed',
          data: {
            outputId,
            provider: embedData.provider,
            title: embedData.title || 'Embedded content'
          }
        });

        return {
          textResultForLlm: `[output:${outputId}] Embedding queued for ${embedData.provider}: ${info}. Rendering happens client-side; success cannot be confirmed at tool layer.`,
          toolTelemetry: { 
            outputId, 
            provider: embedData.provider,
            title: embedData.title,
            author: embedData.author
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          textResultForLlm: `Error embedding media: ${message}`,
          resultType: 'error' as const
        };
      }
    }
  });

  return [embedMedia];
}
