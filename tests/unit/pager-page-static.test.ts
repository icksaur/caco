import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The pager page renders model-authored text (session names, action options).
 * Its correct rendering is only checkable by eye, but the regression that would
 * make it dangerous — reaching for an HTML sink — is cheap to pin statically.
 */
const page = readFileSync(join(process.cwd(), 'public', 'pager.html'), 'utf8');

describe('public/pager.html', () => {
  it('uses no raw-HTML sink', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(page).not.toContain(sink);
    }
  });

  it('polls the pager endpoint and acts through the documented routes', () => {
    expect(page).toContain('/api/pager?wait=');
    expect(page).toContain('/messages');
    // Dismiss goes to the pager's own endpoint, never /observe: clearing the
    // shared unobserved flag from here would blank the dot on every other client.
    expect(page).toContain('/pager-dismiss');
    expect(page).not.toContain('/observe');
  });

  it('encodes the session id into every action URL', () => {
    // A session id is server-generated, but building URLs by concatenation is the
    // habit that eventually breaks on something that needs escaping.
    const urlBuilds = page.match(/'\/api\/sessions\/' \+ [^,)]+/g) ?? [];
    expect(urlBuilds.length).toBeGreaterThan(0);
    for (const build of urlBuilds) expect(build).toContain('encodeURIComponent');
  });

  it('sends no source field, so actions post as plain user messages', () => {
    expect(page).not.toContain('source:');
  });
});
