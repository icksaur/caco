import { SHELL_TOOLS, AGENT_BOUNDED_READ_TOOLS, SHAPE_THRESHOLD_BYTES, GENERIC_HEAD_LINES, GENERIC_TAIL_LINES } from './types.js';
import { selectShaper, genericShaper } from './registry.js';

export interface ShapeDecision {
  shaped: string;
  shaperId: string;
  rawBytes: number;
  shapedBytes: number;
}

/**
 * Guarantee that a format shaper's output contains every non-blank line the
 * generic floor would keep (its head/tail). This makes "format output is a
 * superset of the generic floor" a property of construction, not of the test
 * fixtures: a format parser that misses a failure line still cannot drop it if
 * that line falls in the floor's head or tail.
 */
function enforceGenericFloor(formatShaped: string, raw: string): string {
  const lines = raw.split('\n');
  const headCount = Math.min(GENERIC_HEAD_LINES, lines.length);
  const tailCount = Math.min(GENERIC_TAIL_LINES, Math.max(0, lines.length - headCount));
  const floorLines = [...lines.slice(0, headCount), ...lines.slice(lines.length - tailCount)];

  const present = new Set(formatShaped.split('\n').map(l => l.trim()));
  const missing = floorLines.filter(l => l.trim() !== '' && !present.has(l.trim()));
  if (missing.length === 0) return formatShaped;

  return `${formatShaped}\n[generic floor — lines the summary omitted:]\n${missing.join('\n')}`;
}

/**
 * Decide whether and how to shape a tool result. Returns null when the output
 * passes through unchanged (an agent-bounded read, below threshold, or shaping
 * does not reduce bytes).
 *
 * Agent-bounded read tools (view/read_file/...) pass through untouched: the agent
 * already chose the extent, so shaping only forces a preview + retrieve_output
 * round trips. Shell-class tools get semantic shaping (format shaper, then
 * generic-floor union) so failures survive. Every other tool gets the generic floor
 * only -- the mandatory backstop that keeps the raised runtime threshold from
 * unbounding output the agent cannot itself bound. The generic floor is
 * byte-bounded, so shaping always caps the bytes handed to the model.
 */
export function shapeOutput(toolName: string, raw: string): ShapeDecision | null {
  if (AGENT_BOUNDED_READ_TOOLS.has(toolName)) return null;

  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes <= SHAPE_THRESHOLD_BYTES) return null;

  let shaped: string;
  let shaperId: string;

  if (SHELL_TOOLS.has(toolName)) {
    const shaper = selectShaper(raw, { toolName });
    shaperId = shaper.id;
    shaped = shaper.shape(raw).shaped;
    if (shaper.id !== 'generic') shaped = enforceGenericFloor(shaped, raw);
  } else {
    shaperId = genericShaper.id;
    shaped = genericShaper.shape(raw).shaped;
  }

  const shapedBytes = Buffer.byteLength(shaped, 'utf8');
  if (shapedBytes >= rawBytes) return null;

  return { shaped, shaperId, rawBytes, shapedBytes };
}
