import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getOutput } from '../output-store.js';
import { RETRIEVE_OUTPUT_CAP_BYTES } from './types.js';

function err(message: string) {
  return { textResultForLlm: message };
}

function cap(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= RETRIEVE_OUTPUT_CAP_BYTES) return text;
  const slice = Buffer.from(text, 'utf8').subarray(0, RETRIEVE_OUTPUT_CAP_BYTES).toString('utf8');
  return `${slice}\n[truncated to ${RETRIEVE_OUTPUT_CAP_BYTES / 1024} KB — narrow with range or grep]`;
}

export function createRetrieveOutputTool(sessionCwd: string) {
  const retrieve = defineTool('retrieve_output', {
    description: `Fetch the full raw output that a prior tool result was shaped from. When a bash/test/build result shows "[Output shaped … retrieve_output id=\\"out_…\\"]", call this with that id to see everything that was hidden.

Narrow large output with \`range\` (1-based inclusive line span) or \`grep\` (only matching lines, with their line numbers). Apply both to grep within a line range. Without either, returns the whole output capped at ${RETRIEVE_OUTPUT_CAP_BYTES / 1024} KB.`,
    parameters: z.object({
      id: z.string().describe('The out_… id from a shaped-output handle.'),
      range: z.array(z.number().int()).length(2).optional()
        .describe('1-based inclusive [start, end] line range.'),
      grep: z.string().optional().describe('Keep only lines matching this regex (case-insensitive).'),
    }),
    handler: async ({ id, range, grep }) => {
      const stored = getOutput(id);
      if (!stored) return err(`Error: no stored output for id "${id}" (it may have expired).`);
      if (stored.metadata.sessionCwd && stored.metadata.sessionCwd !== sessionCwd) {
        return err(`Error: no stored output for id "${id}" in this session.`);
      }

      const data = typeof stored.data === 'string' ? stored.data : stored.data.toString('utf8');
      const allLines = data.split('\n');
      const total = allLines.length;

      let start = 1;
      let lines = allLines.map((text, i) => ({ n: i + 1, text }));

      if (range) {
        const [from, to] = range;
        if (from < 1 || to < from) return err(`Error: invalid range [${from}, ${to}].`);
        start = from;
        lines = lines.filter(l => l.n >= from && l.n <= to);
      }

      if (grep) {
        if (grep.length > 200) return err('Error: grep pattern too long (max 200 chars).');
        let re: RegExp;
        try {
          re = new RegExp(grep, 'i');
        } catch {
          return err(`Error: invalid grep pattern "${grep}".`);
        }
        lines = lines.filter(l => re.test(l.text));
      }

      if (lines.length === 0) {
        return err(`No lines matched (output has ${total} lines).`);
      }

      const numbered = lines.map(l => `${l.n}: ${l.text}`).join('\n');
      const header = grep
        ? `${lines.length} of ${total} lines matched "${grep}"${range ? ` in [${range[0]}, ${range[1]}]` : ''}:`
        : `Lines ${start}-${start + lines.length - 1} of ${total}:`;

      return { textResultForLlm: cap(`${header}\n${numbered}`) };
    },
  });

  return [retrieve];
}
