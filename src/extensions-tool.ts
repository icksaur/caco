/**
 * Extension Introspection Tool
 *
 * Lets the agent discover loaded extensions, their tools, and capabilities.
 * Follows the same pull-on-demand pattern as caco_applet_usage and caco_dev_docs.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getExtensionMetadata } from './extension-runtime.js';

export function createExtensionsTool() {
  const tool = defineTool('caco_extensions', {
    description: 'List loaded extensions and their capabilities. Call this to discover what extensions are installed, what tools they provide, and what they can do.',
    parameters: z.object({}),
    handler: async () => {
      const metadata = getExtensionMetadata();
      if (metadata.length === 0) {
        return { textResultForLlm: 'No extensions loaded.' };
      }
      return {
        textResultForLlm: JSON.stringify({ extensions: metadata }, null, 2),
      };
    },
  });
  return [tool];
}
