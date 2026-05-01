import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionPresentation, setSessionPresentation, deleteSessionData, type Presentation } from './storage.js';
import type { SessionIdRef } from './types.js';

const MAX_SLIDES = 100;

export interface PresentationUpdateParams {
  title?: string;
  slides?: string[];
  addSlide?: string;
  addSlideIndex?: number;
  updateSlideIndex?: number;
  updateSlide?: string;
  removeSlideIndex?: number;
  removeAll?: boolean;
}

/** Pure mutation function — shared by MCP tool and REST route */
export function applyPresentationUpdate(existing: Presentation | null, params: PresentationUpdateParams): Presentation | null {
  if (params.removeAll) return null;

  const pres: Presentation = existing || { title: '', slides: [] };

  if (params.title !== undefined) pres.title = params.title;
  if (params.slides !== undefined) pres.slides = params.slides.slice(0, MAX_SLIDES);

  if (params.addSlide !== undefined) {
    if (pres.slides.length >= MAX_SLIDES) {
      throw new Error(`Cannot add slide: maximum ${MAX_SLIDES} slides reached`);
    }
    if (params.addSlideIndex !== undefined && params.addSlideIndex >= 0 && params.addSlideIndex <= pres.slides.length) {
      pres.slides.splice(params.addSlideIndex, 0, params.addSlide);
    } else {
      pres.slides.push(params.addSlide);
    }
  }

  if (params.updateSlide !== undefined && params.updateSlideIndex !== undefined) {
    if (params.updateSlideIndex >= 0 && params.updateSlideIndex < pres.slides.length) {
      pres.slides[params.updateSlideIndex] = params.updateSlide;
    }
  }

  if (params.removeSlideIndex !== undefined) {
    if (params.removeSlideIndex >= 0 && params.removeSlideIndex < pres.slides.length) {
      pres.slides.splice(params.removeSlideIndex, 1);
    }
  }

  return pres;
}

export function createPresentationTools(sessionRef: SessionIdRef) {

  const getPresentation = defineTool('get_presentation', {
    description: `Get the presentation for the current session. Returns title and slides array.

Call this to check if a presentation exists or to read its content. Returns empty if no presentation exists.`,
    parameters: z.object({
      sessionId: z.string().optional().describe('Read another session\'s presentation (read-only). Use the caco-session:UUID from user input.'),
    }),
    handler: async ({ sessionId }) => {
      const targetId = sessionId || sessionRef.id;
      const pres = getSessionPresentation(targetId);
      if (!pres) return { exists: false, message: targetId === sessionRef.id
        ? 'No presentation exists for this session. Use update_presentation to create one.'
        : `No presentation exists for session ${targetId.slice(0, 8)}.` };
      return { ...pres, slideCount: pres.slides.length };
    }
  });

  const updatePresentation = defineTool('update_presentation', {
    description: `Create or update a visual presentation for the current session. Use slides to explain architecture, show diagrams, present plans, or summarize findings. Each slide is markdown — supports mermaid diagrams, code blocks, lists, and headings.

All parameters are optional — set whatever you need in one call.

Examples:
  Create: { title: "Architecture", slides: ["# Overview\\n\\nMain components", "# Data Flow\\n\\n\`\`\`mermaid\\ngraph LR\\nA-->B\\n\`\`\`"] }
  Add slide: { addSlide: "# New Slide\\n\\nContent here" }
  Update slide 2: { updateSlideIndex: 1, updateSlide: "# Updated\\n\\nNew content" }
  Delete all: { removeAll: true }`,
    parameters: z.object({
      title: z.string().optional(),
      slides: z.array(z.string()).optional().describe('Replace entire slide list'),
      addSlide: z.string().optional().describe('Append a slide (or insert at addSlideIndex)'),
      addSlideIndex: z.number().optional().describe('Insert position for addSlide'),
      updateSlideIndex: z.number().optional().describe('Index of slide to update'),
      updateSlide: z.string().optional().describe('New content for slide at updateSlideIndex'),
      removeSlideIndex: z.number().optional().describe('Remove slide at index'),
      removeAll: z.boolean().optional().describe('Delete the entire presentation'),
    }),
    handler: async (params) => {
      const existing = getSessionPresentation(sessionRef.id);

      try {
        const result = applyPresentationUpdate(existing, params);
        if (result === null) {
          deleteSessionData(sessionRef.id, 'presentation');
          return { removed: true, message: 'Presentation deleted.' };
        }
        setSessionPresentation(sessionRef.id, result);
        return { ...result, slideCount: result.slides.length };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  return [getPresentation, updatePresentation];
}
