// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRegions } from '../../public/ts/dom-regions.js';
import { renderMarkdownElement, setupMarkdownRenderer } from '../../public/ts/markdown-renderer.js';

type CodeRenderer = (code: string, language: string) => string;

interface MarkedFake {
  renderer?: { code?: CodeRenderer };
  use: ReturnType<typeof vi.fn>;
  parse: ReturnType<typeof vi.fn>;
}

interface SanitizeConfig {
  FORBID_ATTR?: string[];
  FORBID_TAGS?: string[];
}

function installDom(): void {
  document.body.innerHTML = `
    <main id="chatScroll">
      <section id="chat"></section>
    </main>
    <aside data-applet-view></aside>
    <footer data-context-footer></footer>
  `;
  initRegions();
}

function escapeText(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, char => map[char]);
}

function renderInline(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => `<a href="${escapeText(href)}">${escapeText(label)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdownWith(markedFake: MarkedFake, markdown: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fenceRe)) {
    const index = match.index ?? 0;
    const before = markdown.slice(cursor, index).trim();
    if (before) chunks.push(`<p>${renderInline(before)}</p>`);
    const language = match[1].trim();
    const code = match[2].replace(/\n$/, '');
    chunks.push(markedFake.renderer?.code?.(code, language) ?? `<pre><code>${escapeText(code)}</code></pre>`);
    cursor = index + match[0].length;
  }
  const rest = markdown.slice(cursor).trim();
  if (rest) chunks.push(`<p>${renderInline(rest)}</p>`);
  return chunks.join('');
}

function installMarkdownGlobals(): { markedFake: MarkedFake; highlightElement: ReturnType<typeof vi.fn> } {
  const markedFake: MarkedFake = {
    use: vi.fn(options => {
      markedFake.renderer = options.renderer;
    }),
    parse: vi.fn((markdown: string) => renderMarkdownWith(markedFake, markdown)),
  };
  const highlightElement = vi.fn();
  vi.stubGlobal('marked', markedFake);
  vi.stubGlobal('DOMPurify', {
    sanitize: vi.fn((html: string, config: SanitizeConfig) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      for (const tag of config.FORBID_TAGS ?? []) {
        for (const el of template.content.querySelectorAll(tag)) el.remove();
      }
      for (const el of template.content.querySelectorAll('*')) {
        for (const attr of config.FORBID_ATTR ?? []) el.removeAttribute(attr);
      }
      return template.innerHTML;
    }),
  });
  vi.stubGlobal('hljs', { highlightElement });
  return { markedFake, highlightElement };
}

function setupRenderer(): { markedFake: MarkedFake; highlightElement: ReturnType<typeof vi.fn> } {
  const globals = installMarkdownGlobals();
  setupMarkdownRenderer();
  return globals;
}

beforeEach(() => {
  vi.restoreAllMocks();
  installDom();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.head.querySelectorAll('script[src="mermaid.min.js"]').forEach(script => script.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderMarkdownElement', () => {
  it('renders bold text and links into HTML structure', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = 'Read **bold** at [docs](https://example.test/path?a=1&b=2)';

    renderMarkdownElement(el);

    const strong = el.querySelector('strong');
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(el.classList.contains('markdown-content')).toBe(true);
    expect(strong?.textContent).toBe('bold');
    expect(link.textContent).toBe('docs');
    expect(link.getAttribute('href')).toBe('https://example.test/path?a=1&b=2');
  });

  it('renders code fences as escaped pre/code blocks with language classes', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '```ts\nconst x = \'<tag>\';\n```';

    renderMarkdownElement(el);

    const pre = el.querySelector('pre');
    const code = el.querySelector('code') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.classList.contains('language-ts')).toBe(true);
    expect(code.textContent).toBe('const x = \'<tag>\';');
    expect(code.innerHTML).toContain('&lt;tag&gt;');
  });

  it('sanitizes raw HTML by removing forbidden tags, ids, and event attributes', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '<script>alert(1)</script><a id="bad" onclick="evil()" href="https://safe.test">safe</a>';

    renderMarkdownElement(el);

    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(el.querySelector('script')).toBeNull();
    expect(link.textContent).toBe('safe');
    expect(link.id).toBe('');
    expect(link.getAttribute('onclick')).toBeNull();
    expect(link.getAttribute('href')).toBe('https://safe.test');
  });

  it('hides caco action fences instead of rendering transcript code', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '```caco-actions\n{"type":"button"}\n```';

    renderMarkdownElement(el);

    expect(el.innerHTML).toBe('');
    expect(el.classList.contains('markdown-content')).toBe(true);
  });

  it('replaces complete caco-embed fences with sandboxed whitelisted iframes', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '```caco-embed\nhttps://youtu.be/abcDEF_123\n```';

    renderMarkdownElement(el);

    const frame = el.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.classList.contains('media-embed-frame')).toBe(true);
    expect(frame.classList.contains('media-embed-youtube')).toBe(true);
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abcDEF_123');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-presentation allow-popups');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
  });

  it('preserves the streaming cursor class across incremental rendering', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.className = 'streaming-cursor';
    el.textContent = '**streaming**';

    renderMarkdownElement(el);

    expect(el.classList.contains('streaming-cursor')).toBe(true);
    expect(el.querySelector('strong')?.textContent).toBe('streaming');
  });

  it('does nothing for blank markdown text', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '   ';

    renderMarkdownElement(el);

    expect(el.innerHTML).toBe('   ');
    expect(el.classList.contains('markdown-content')).toBe(false);
  });

  it('renders mermaid diagrams after lazy loading and reports parse and render failures', async () => {
    setupRenderer();
    const mermaid = {
      initialize: vi.fn(),
      parse: vi.fn((_code: string) => Promise.resolve()),
      render: vi.fn((_id: string, _code: string) => Promise.resolve({ svg: '<svg data-diagram="ok"></svg>' })),
    };
    vi.stubGlobal('mermaid', mermaid);
    const el = document.createElement('div');
    el.textContent = '```mermaid\ngraph TD; A-->B;\n```';

    renderMarkdownElement(el);
    const script = document.head.querySelector('script[src="mermaid.min.js"]') as HTMLScriptElement;
    script.onload?.(new Event('load'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, theme: 'dark' }));
    expect(mermaid.parse).toHaveBeenCalledWith('graph TD; A-->B;');
    expect(mermaid.render.mock.calls[0][0]).toMatch(/^mermaid-[a-z0-9]+-svg$/);
    expect(el.querySelector('svg')?.getAttribute('data-diagram')).toBe('ok');

    mermaid.parse.mockRejectedValueOnce(new Error('bad diagram'));
    const invalid = document.createElement('div');
    invalid.textContent = '```mermaid\nnot diagram\n```';
    renderMarkdownElement(invalid);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invalid.querySelector('.mermaid-error')?.textContent).toBe('Invalid diagram syntax');

    mermaid.parse.mockResolvedValueOnce(undefined);
    mermaid.render.mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderError = document.createElement('div');
    renderError.textContent = '```mermaid\ngraph TD; B-->C;\n```';
    renderMarkdownElement(renderError);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(consoleError).toHaveBeenCalledWith('Mermaid rendering error:', expect.any(Error));
    expect(renderError.querySelector('.mermaid-error')?.textContent).toBe('Error rendering diagram: boom');
  });

  it('renders caco-embed fallbacks as safe links or text for non-whitelisted values', () => {
    setupRenderer();
    const el = document.createElement('div');
    el.textContent = '```caco-embed\nhttps://example.test/video\nnot a url\n```';

    renderMarkdownElement(el);

    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('https://example.test/video');
    expect(link.href).toBe('https://example.test/video');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(el.querySelector('.media-embed')?.textContent).toContain('not a url');
  });
});

describe('setupMarkdownRenderer', () => {
  it('exports render functions and renders unprocessed markdown content in the chat region', async () => {
    const chat = document.getElementById('chat') as HTMLElement;
    chat.innerHTML = `
      <article data-markdown>
        <div class="markdown-content">Before **after**\n\n\`\`\`js\nconsole.log(1)\n\`\`\`</div>
      </article>
    `;

    const { markedFake, highlightElement } = setupRenderer();
    await Promise.resolve();
    await Promise.resolve();

    const parent = chat.querySelector('[data-markdown]') as HTMLElement;
    const content = chat.querySelector('.markdown-content') as HTMLElement;
    expect(markedFake.use).toHaveBeenCalled();
    expect(window.renderMarkdownElement).toBe(renderMarkdownElement);
    expect(typeof window.renderMarkdown).toBe('function');
    expect(parent.dataset.markdownProcessed).toBe('true');
    expect(content.querySelector('strong')?.textContent).toBe('after');
    expect(content.querySelector('code')?.classList.contains('language-js')).toBe(true);
    expect(highlightElement).toHaveBeenCalledWith(content.querySelector('code'));
  });

  it('skips processed parents, empty markdown content, and content that already contains rendered blocks', async () => {
    const chat = document.getElementById('chat') as HTMLElement;
    chat.innerHTML = `
      <article data-markdown data-markdown-processed="true">
        <div class="markdown-content">**skip processed**</div>
      </article>
      <article data-markdown>
        <div class="markdown-content">   </div>
      </article>
      <article data-markdown>
        <div class="markdown-content"><p>already rendered</p></div>
      </article>
    `;

    const { markedFake } = setupRenderer();
    await Promise.resolve();
    await Promise.resolve();

    const articles = chat.querySelectorAll<HTMLElement>('[data-markdown]');
    expect(markedFake.parse).not.toHaveBeenCalled();
    expect(articles[0].dataset.markdownProcessed).toBe('true');
    expect(articles[1].dataset.markdownProcessed).toBe('true');
    expect(articles[2].dataset.markdownProcessed).toBe('true');
    expect(articles[0].querySelector('.markdown-content')?.textContent).toBe('**skip processed**');
    expect(articles[2].querySelector('p')?.textContent).toBe('already rendered');
  });

  it('waits for DOMContentLoaded before initial rendering while document is loading', async () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    const chat = document.getElementById('chat') as HTMLElement;
    chat.innerHTML = `
      <article data-markdown>
        <div class="markdown-content">Loaded **later**</div>
      </article>
    `;

    setupRenderer();

    expect(chat.querySelector('strong')).toBeNull();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(chat.querySelector('strong')?.textContent).toBe('later');
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
  });
});
