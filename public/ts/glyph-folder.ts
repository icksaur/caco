/** Client copy of src/folder.ts isGlyphFolder: a folder named with one emoji is a pin (spec-session-pin). */
const GLYPH_FOLDER = /^\p{Extended_Pictographic}\uFE0F?$/u;

export const PIN_GLYPH = '📌';

export function isGlyphFolder(input: string | undefined | null): boolean {
  return typeof input === 'string' && GLYPH_FOLDER.test(input.trim());
}
