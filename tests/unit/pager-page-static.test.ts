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

  it('renders running sessions as rows, not as a count', () => {    // "How many are working" is the question the page used to answer; the useful
    // one is "which". Reading busyCount again would regress that, and it would
    // also silently take the two-state empty message with it, since that branch
    // used to read the same field.
    expect(page).not.toContain('busyCount');
    expect(page).toContain('run-row');
    expect(page).toContain('work in progress');
  });

  it('carries no title and centres the status badge', () => {
    expect(page).not.toContain('<h1>');
    expect(page).toContain('justify-content: center');
  });

  it('keeps the free-text well featureless', () => {
    // The well must not grow into a chat client: reaching for the chat form
    // would drag the popup/router stack into a page that is build-free on
    // purpose. Pin the absence of the machinery, not just the intent.
    for (const feature of ['chat-form', 'slashCommand', 'mention', 'autocomplete', 'bundle.js']) {
      expect(page).not.toContain(feature);
    }
  });
});
