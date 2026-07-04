/**
 * Per-turn tool-definition token estimate (spec-deferred-savings S1).
 *
 * The model receives each tool as a SERIALIZED JSON definition, so we count the
 * full JSON length — keys AND values (schema keys like `type`/`properties`/`enum`
 * and every parameter name are real tokens, and dominate for schema-heavy tools) —
 * ÷ BYTES_PER_TOKEN. The char count is exact for the transmitted JSON; only the ÷4
 * chars-per-token ratio is an approximation (no tokenizer).
 *
 * Leaf module: the single home for this estimate so the applet payload AND the
 * observed-size capture path share ONE definition (no second estimator). Pure; the
 * unit-test oracle for the "≈N tokens" display.
 */
export function estimateToolTokens(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | null;
  instructions?: string | null;
}): number {
  const def: Record<string, unknown> = { name: tool.name };
  if (tool.description) def.description = tool.description;
  if (tool.parameters) def.parameters = tool.parameters;
  if (tool.instructions) def.instructions = tool.instructions;
  return Math.round(JSON.stringify(def).length / 4);
}
