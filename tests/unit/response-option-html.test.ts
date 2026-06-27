// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildResponseOptionsHtml } from '../../public/ts/response-option-html.js';

/** Parse the built HTML into real buttons so we can read dataset/title as a browser would. */
function render(options: string[], muted = false): HTMLButtonElement[] {
  const host = document.createElement('div');
  host.innerHTML = buildResponseOptionsHtml(options, muted);
  return [...host.querySelectorAll<HTMLButtonElement>('button.response-option-btn')];
}

describe('buildResponseOptionsHtml', () => {
  it('carries the full text identically in data-prompt and title (what is sent === tooltip)', () => {
    const text = 'Run /code-review on "src/x.ts" & fix <bug> with prompt';
    const [btn] = render([text]);
    expect(btn.dataset.prompt).toBe(text);
    expect(btn.title).toBe(text);
    expect(btn.dataset.prompt).toBe(btn.title);
  });

  it('preserves a long (up to 200-char) action verbatim — no visual truncation in the value', () => {
    const text = 'x'.repeat(200);
    const [btn] = render([text]);
    expect(btn.dataset.prompt).toBe(text);
    expect(btn.title).toBe(text);
    expect(btn.dataset.prompt).toHaveLength(200);
  });

  it('round-trips tricky characters (quotes, ampersand, entity-looking text, angle brackets)', () => {
    const tricky = '"&quot;" & <script> \'apos\' & ampersand';
    const [btn] = render([tricky]);
    expect(btn.dataset.prompt).toBe(tricky);
    expect(btn.title).toBe(tricky);
  });

  it('marks muted buttons and renders one per option', () => {
    const btns = render(['a', 'b', 'c', 'd'], true);
    expect(btns).toHaveLength(4);
    expect(btns.every(b => b.classList.contains('muted'))).toBe(true);
  });

  it('renders nothing for an empty list', () => {
    expect(buildResponseOptionsHtml([], false)).toBe('');
  });
});
