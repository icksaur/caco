// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { initRegions } from '../../public/ts/dom-regions.js';
import { renderMarkdownElement, setupMarkdownRenderer } from '../../public/ts/markdown-renderer.js';

/**
 * Chat renders a lone newline as a line break (marked `breaks: true`), the
 * convention for chat. Documents must not: models hard-wrap Markdown files at
 * around 80 columns, and treating each wrap as a break turns every paragraph
 * into a column of short ragged lines. A document preview renders a lone
 * newline as a space, as CommonMark, GitHub's file view and VS Code do.
 *
 * These run the vendored marked bundle, not a fake: the behavior under test is
 * marked's own handling of the option Caco passes.
 */

const repoRoot = join(__dirname, '..', '..');
const markedSrc = readFileSync(join(repoRoot, 'public', 'marked.min.js'), 'utf-8');
const viewerSrc = readFileSync(join(repoRoot, 'applets', 'files', 'markdown-viewer.js'), 'utf-8');

const WRAPPED = 'Models often wrap a paragraph\nat eighty columns, so one\nthought spans several lines.';
const JOINED = 'Models often wrap a paragraph at eighty columns, so one thought spans several lines.';

function installRealMarkdown(): void {
  document.body.innerHTML = '<main id="chatScroll"><section id="chat"></section></main><aside data-applet-view></aside><footer data-context-footer></footer>';
  initRegions();
  // The UMD bundle, run with no `exports` in scope, attaches to globalThis.marked.
  new Function(markedSrc)();
  vi.stubGlobal('DOMPurify', { sanitize: (html: string) => html });
  setupMarkdownRenderer();
}

function paragraphs(el: Element): HTMLParagraphElement[] {
  return Array.from(el.querySelectorAll('p'));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

beforeEach(() => { installRealMarkdown(); });

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { marked?: unknown }).marked;
  delete (window as { __filesApplet?: unknown }).__filesApplet;
  document.body.innerHTML = '';
});

describe('line breaks inside a paragraph', () => {
  it('keeps a lone newline as a line break in chat', () => {
    const el = document.createElement('div');
    el.textContent = WRAPPED;

    renderMarkdownElement(el);

    expect(el.querySelectorAll('br')).toHaveLength(2);
  });

  it('joins a hard-wrapped paragraph in a document', () => {
    const el = document.createElement('div');
    el.textContent = WRAPPED;

    renderMarkdownElement(el, { breaks: false });

    expect(el.querySelectorAll('br')).toHaveLength(0);
    expect(paragraphs(el)).toHaveLength(1);
    expect(collapse(paragraphs(el)[0].textContent ?? '')).toBe(JOINED);
  });

  it('still honors an explicit hard break in a document', () => {
    const el = document.createElement('div');
    el.textContent = 'first line  \nsecond line';

    renderMarkdownElement(el, { breaks: false });

    expect(el.querySelectorAll('br')).toHaveLength(1);
  });

  it('keeps Caco code-block rendering in a document', () => {
    const el = document.createElement('div');
    el.textContent = 'Intro\nwrapped.\n\n```ts\nconst x = 1;\n```';

    renderMarkdownElement(el, { breaks: false });

    expect(el.querySelector('code')?.classList.contains('hljs')).toBe(true);
  });

  it('does not change how chat renders afterwards', () => {
    const doc = document.createElement('div');
    doc.textContent = WRAPPED;
    renderMarkdownElement(doc, { breaks: false });

    const chat = document.createElement('div');
    chat.textContent = WRAPPED;
    renderMarkdownElement(chat);

    expect(chat.querySelectorAll('br')).toHaveLength(2);
  });
});

describe('files applet Markdown preview', () => {
  it('renders a hard-wrapped file as joined paragraphs', () => {
    new Function(viewerSrc)();
    const { MarkdownViewer } = (window as unknown as {
      __filesApplet: { MarkdownViewer: new (...args: unknown[]) => { _renderToDom(text: string): void; _mdEl: HTMLElement } };
    }).__filesApplet;
    const viewer = new MarkdownViewer({}, {}, '/repo/plan.md');

    viewer._renderToDom(`# Plan\n\n${WRAPPED}\n\nSecond paragraph\nalso wrapped.`);

    expect(viewer._mdEl.querySelectorAll('br')).toHaveLength(0);
    const texts = paragraphs(viewer._mdEl).map(p => collapse(p.textContent ?? ''));
    expect(texts).toEqual([JOINED, 'Second paragraph also wrapped.']);
  });
});
