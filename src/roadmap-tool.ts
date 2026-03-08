import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionRoadmap, setSessionRoadmap, type Roadmap, type RoadmapStep } from './storage.js';
import type { SessionIdRef } from './types.js';

export function createRoadmapTools(sessionRef: SessionIdRef) {
  const getRoadmap = defineTool('get_roadmap', {
    description: `Get the roadmap for the current session. Returns the title, documents, and step list with statuses.

Call this after session resume or context compaction to recover project state. The roadmap persists on disk and survives compaction.

Returns empty object if no roadmap exists yet.`,
    parameters: z.object({}),
    handler: async () => {
      const roadmap = getSessionRoadmap(sessionRef.id);
      if (!roadmap) return { exists: false, message: 'No roadmap exists for this session. Use update_roadmap to create one.' };
      return roadmap;
    }
  });

  const updateRoadmap = defineTool('update_roadmap', {
    description: `Update the session roadmap. Use structured actions to modify the roadmap without editing JSON directly.

Actions:
- set_title: Set the roadmap title
- add_step: Add a new step (appended to end, or at stepIndex)
- update_step: Update an existing step's fields (by stepIndex)
- remove_step: Remove a step (by stepIndex)
- add_document: Add a document path to the document list
- remove_document: Remove a document path
- reorder_steps: Set new step order (array of current indices)

Step statuses: pending, active, done, blocked`,
    parameters: z.object({
      action: z.enum(['set_title', 'add_step', 'update_step', 'remove_step', 'add_document', 'remove_document', 'reorder_steps']),
      title: z.string().optional().describe('For set_title action'),
      step: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'done', 'blocked']).optional(),
        context: z.array(z.string()).optional(),
      }).optional().describe('For add_step, update_step'),
      stepIndex: z.number().optional().describe('For update_step, remove_step, add_step (insert position)'),
      document: z.string().optional().describe('For add_document, remove_document'),
      order: z.array(z.number()).optional().describe('For reorder_steps: new index order'),
    }),
    handler: async ({ action, title, step, stepIndex, document, order }) => {
      const roadmap: Roadmap = getSessionRoadmap(sessionRef.id) || { title: '', steps: [] };

      switch (action) {
        case 'set_title':
          if (!title) return { error: 'title required' };
          roadmap.title = title;
          break;

        case 'add_step': {
          if (!step) return { error: 'step required' };
          const newStep: RoadmapStep = { title: step.title, description: step.description, status: step.status || 'pending', context: step.context };
          if (stepIndex !== undefined && stepIndex >= 0 && stepIndex <= roadmap.steps.length) {
            roadmap.steps.splice(stepIndex, 0, newStep);
          } else {
            roadmap.steps.push(newStep);
          }
          break;
        }

        case 'update_step':
          if (stepIndex === undefined || !roadmap.steps[stepIndex]) return { error: 'valid stepIndex required' };
          if (step) {
            if (step.title) roadmap.steps[stepIndex].title = step.title;
            if (step.description !== undefined) roadmap.steps[stepIndex].description = step.description;
            if (step.status) roadmap.steps[stepIndex].status = step.status;
            if (step.context) roadmap.steps[stepIndex].context = step.context;
          }
          break;

        case 'remove_step':
          if (stepIndex === undefined || !roadmap.steps[stepIndex]) return { error: 'valid stepIndex required' };
          roadmap.steps.splice(stepIndex, 1);
          break;

        case 'add_document':
          if (!document) return { error: 'document required' };
          if (!roadmap.documents) roadmap.documents = [];
          if (!roadmap.documents.includes(document)) roadmap.documents.push(document);
          break;

        case 'remove_document':
          if (!document) return { error: 'document required' };
          roadmap.documents = (roadmap.documents || []).filter(d => d !== document);
          break;

        case 'reorder_steps':
          if (!order || order.length !== roadmap.steps.length) return { error: 'order must be array of all step indices' };
          roadmap.steps = order.map(i => roadmap.steps[i]).filter(Boolean);
          break;
      }

      setSessionRoadmap(sessionRef.id, roadmap);
      return roadmap;
    }
  });

  return [getRoadmap, updateRoadmap];
}
