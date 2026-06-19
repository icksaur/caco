import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionRoadmap, setSessionRoadmap, getSessionNotes, appendSessionNote, type Roadmap, type RoadmapStep } from './storage.js';
import type { SessionIdRef } from './types.js';

export function createRoadmapTools(sessionRef: SessionIdRef) {

  function findStepByTitle(steps: RoadmapStep[], query: string): { index: number } | { error: string } {
    const lower = query.toLowerCase();
    const exact = steps.findIndex(s => s.title.toLowerCase() === lower);
    if (exact >= 0) return { index: exact };
    const prefixMatches = steps.map((s, i) => ({ i, t: s.title })).filter(x => x.t.toLowerCase().startsWith(lower));
    if (prefixMatches.length === 1) return { index: prefixMatches[0].i };
    if (prefixMatches.length === 0) return { error: `No step matching "${query}". Steps: ${steps.map(s => s.title).join(', ')}` };
    return { error: `Ambiguous: "${query}" matches: ${prefixMatches.map(m => m.t).join(', ')}` };
  }

  const getRoadmap = defineTool('get_roadmap', {
    description: `Get the current session's roadmap: title, documents, and steps with statuses. Returns empty object if none exists.

Call after session resume or context compaction to recover project state (the roadmap persists on disk).`,
    parameters: z.object({
      sessionId: z.string().optional().describe('Read another session\'s roadmap (read-only). Use the caco-session:UUID from user input.'),
    }),
    handler: async ({ sessionId }) => {
      const targetId = sessionId || sessionRef.id;
      const roadmap = getSessionRoadmap(targetId);
      if (!roadmap) return { exists: false, message: targetId === sessionRef.id
        ? 'No roadmap exists for this session. Use update_roadmap to create one.'
        : `No roadmap exists for session ${targetId.slice(0, 8)}.` };
      return roadmap;
    }
  });

  const updateRoadmap = defineTool('update_roadmap', {
    description: `Update the session roadmap. All params optional — set whatever you need in one call.

- title / documents: set title, or replace the document list
- steps: replace the entire step list (bulk create/reorder)
- addStep (+ addStepIndex): append or insert one step
- updateStep (by updateStepIndex OR stepTitle): change fields on a step
- removeStepIndex / removeStepTitle: remove a step

Step status: pending | active | done | blocked.

Example: { stepTitle: "Research", updateStep: { status: "done" } }`,
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
      stepTitle: z.string().optional().describe('Find step by title (alternative to updateStepIndex). Case-insensitive prefix match.'),
      updateStep: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'done', 'blocked']).optional(),
        context: z.array(z.string()).optional(),
      }).optional().describe('Fields to update on step at updateStepIndex or stepTitle'),
      removeStepIndex: z.number().optional().describe('Remove step at this index'),
      removeStepTitle: z.string().optional().describe('Remove step by title (alternative to removeStepIndex)'),
    }),
    handler: async ({ title, steps, documents, addStep, addStepIndex, updateStepIndex, stepTitle, updateStep, removeStepIndex, removeStepTitle }) => {
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

      if (updateStep) {
        let idx = updateStepIndex;
        if (idx === undefined && stepTitle) {
          const result = findStepByTitle(roadmap.steps, stepTitle);
          if ('error' in result) return { error: result.error };
          idx = result.index;
        }
        if (idx !== undefined && roadmap.steps[idx]) {
          const s = roadmap.steps[idx];
          if (updateStep.title) s.title = updateStep.title;
          if (updateStep.description !== undefined) s.description = updateStep.description;
          if (updateStep.status) s.status = updateStep.status;
          if (updateStep.context) s.context = updateStep.context;
        }
      }

      if (removeStepTitle && removeStepIndex === undefined) {
        const result = findStepByTitle(roadmap.steps, removeStepTitle);
        if ('error' in result) return { error: result.error };
        roadmap.steps.splice(result.index, 1);
      } else if (removeStepIndex !== undefined && roadmap.steps[removeStepIndex]) {
        roadmap.steps.splice(removeStepIndex, 1);
      }

      setSessionRoadmap(sessionRef.id, roadmap);
      return roadmap;
    }
  });

  const sessionNote = defineTool('session_note', {
    description: `Persistent per-session memory. Record decisions, discoveries, and dead ends; notes survive context compaction. No structure required.

- No params: returns all notes (timestamped)
- append: add a timestamped note
- sessionId: read another session's notes (read-only)`,
    parameters: z.object({
      append: z.string().optional().describe('Text to append as a new timestamped note'),
      sessionId: z.string().optional().describe('Read another session\'s notes (read-only). Use the caco-session:UUID from user input.'),
    }),
    handler: async ({ append, sessionId }) => {
      if (sessionId && sessionId !== sessionRef.id) {
        const notes = getSessionNotes(sessionId);
        if (!notes.length) return { notes: [], message: `No notes for session ${sessionId.slice(0, 8)}.` };
        return { notes };
      }
      if (append) {
        const entry = appendSessionNote(sessionRef.id, append);
        return { appended: entry };
      }
      const notes = getSessionNotes(sessionRef.id);
      if (!notes.length) return { notes: [], message: 'No notes yet. Use append to add one.' };
      return { notes };
    }
  });

  return [getRoadmap, updateRoadmap, sessionNote];
}
