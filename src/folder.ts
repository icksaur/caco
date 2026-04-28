const VALID_CHARS = /[^a-zA-Z0-9 _/-]/g;

export function normalizeFolder(input: string): string {
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
  if (trimmed === '/' || trimmed.toLowerCase() === 'root') return true;
  const withoutLeading = trimmed.replace(/^\//, '').replace(/\/$/, '');
  if (withoutLeading.includes('/')) return false;
  const normalized = normalizeFolder(trimmed);
  return normalized.length > 0;
}
