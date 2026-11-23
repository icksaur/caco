const VALID_CHARS = /[^a-zA-Z0-9 _/-]/g;
const GLYPH_FOLDER = /^\p{Extended_Pictographic}\uFE0F?$/u;

/** A folder named with one emoji is a pin (spec-session-pin). */
export function isGlyphFolder(input: string | undefined | null): boolean {
  return typeof input === 'string' && GLYPH_FOLDER.test(input.trim());
}

export function normalizeFolder(input: string): string {
  if (isGlyphFolder(input)) return input.trim();
  let s = input.trim();
  s = s.replace(/\\/g, '/');
  s = s.replace(VALID_CHARS, '');
  s = s.replace(/\/+/g, '/');
  s = s.replace(/^\/|\/$/g, '');

  // Enforce depth 1: take first segment only
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);

  s = s.trim();

  if (s.toLowerCase() === 'root') return '';
  return s;
}

export function isValidFolder(input: string): boolean {
  const trimmed = input.trim();
  if (isGlyphFolder(trimmed)) return true;
  if (trimmed === '/' || trimmed.toLowerCase() === 'root') return true;
  const withoutLeading = trimmed.replace(/^\//, '').replace(/\/$/, '');
  if (withoutLeading.includes('/')) return false;
  const normalized = normalizeFolder(trimmed);
  return normalized.length > 0;
}
