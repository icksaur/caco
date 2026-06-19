import { SHELL_TOOLS, SHAPE_THRESHOLD_BYTES } from './types.js';
import { selectShaper, genericShaper } from './registry.js';

export interface ShapeDecision {
  shaped: string;
  shaperId: string;
  preserved: number;
  dropped: number;
}

/**
 * Decide whether and how to shape a tool result. Returns null when the output
 * passes through unchanged (below threshold, or shaping compacts nothing).
 *
 * Shell-class tools get semantic shaping (format shaper or generic). Every other
 * tool gets only the generic head/tail cap — the mandatory backstop that keeps
 * the raised runtime threshold from unbounding non-shell output.
 */
export function shapeOutput(toolName: string, raw: string): ShapeDecision | null {
  if (Buffer.byteLength(raw, 'utf8') <= SHAPE_THRESHOLD_BYTES) return null;

  const shaper = SHELL_TOOLS.has(toolName)
    ? selectShaper(raw, { toolName })
    : genericShaper;

  const { shaped, preserved, dropped } = shaper.shape(raw);
  if (dropped === 0 || shaped.length >= raw.length) return null;

  return { shaped, shaperId: shaper.id, preserved, dropped };
}
