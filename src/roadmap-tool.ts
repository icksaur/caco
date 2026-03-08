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
    description: `Update the session roadmap. All parameters are optional — set whatever you need in one call.

- title: Set the roadmap title
- steps: Replace the entire step list (for bulk creation/reorder)
- documents: Replace the entire document list
- addStep: Add a single step (appended, or at addStepIndex)
- updateStep: Update fields on an existing step (requires updateStepIndex)
- removeStepIndex: Remove step at this index

Step statuses: pending, active, done, blocked

Examples:
  Create roadmap: { title: "My Project", steps: [{ title: "Research", status: "active" }, { title: "Implement", status: "pending" }] }
  Mark step done: { updateStepIndex: 0, updateStep: { status: "done" } }
  Add a step: { addStep: { title: "Test", status: "pending" } }`,
    parameters: z.object({
      title: z.string().optional(),
      steps: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'done', 'blocked']).optional(),
        context: z.array(z.string()).optional(),
      })).optional().describe('Replace entire step list'),
      documents: z.array(z.string()).optional().describe('Replace entire document list'),
      addStep: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'done', 'blocked']).optional(),
        context: z.array(z.string()).optional(),
      }).optional().describe('Append a step'),
      addStepIndex: z.number().optional().describe('Insert position for addStep'),
      updateStepIndex: z.number().optional().describe('Index of step to update'),
      updateStep: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'done', 'blocked']).optional(),
        context: z.array(z.string()).optional(),
      }).optional().describe('Fields to update on step at updateStepIndex'),
      removeStepIndex: z.number().optional().describe('Remove step at this index'),
    }),
    handler: async ({ title, steps, documents, addStep, addStepIndex, updateStepIndex, updateStep, removeStepIndex }) => {
      const roadmap: Roadmap = getSessionRoadmap(sessionRef.id) || { title: '', steps: [] };

      if (title !== undefined) roadmap.title = title;
      if (documents !== undefined) roadmap.documents = documents;
      if (steps !== undefined) {
        roadmap.steps = steps.map(s => ({ title: s.title, description: s.description, status: s.status || 'pending', context: s.context }));
      }

      if (addStep) {
        const newStep: RoadmapStep = { title: addStep.title, description: addStep.description, status: addStep.status || 'pending', context: addStep.context };
        if (addStepIndex !== undefined && addStepIndex >= 0 && addStepIndex <= roadmap.steps.length) {
          roadmap.steps.splice(addStepIndex, 0, newStep);
        } else {
          roadmap.steps.push(newStep);
        }
      }

      if (updateStepIndex !== undefined && updateStep && roadmap.steps[updateStepIndex]) {
        const s = roadmap.steps[updateStepIndex];
        if (updateStep.title) s.title = updateStep.title;
        if (updateStep.description !== undefined) s.description = updateStep.description;
        if (updateStep.status) s.status = updateStep.status;
        if (updateStep.context) s.context = updateStep.context;
      }

      if (removeStepIndex !== undefined && roadmap.steps[removeStepIndex]) {
        roadmap.steps.splice(removeStepIndex, 1);
      }

      setSessionRoadmap(sessionRef.id, roadmap);
      return roadmap;
    }
  });

  return [getRoadmap, updateRoadmap];
}
