/**
 * Markdown rendering with Mermaid diagrams and syntax highlighting
 */

import { regions } from './dom-regions.js';

interface MermaidAPI {
  initialize(config: object): void;
  parse(code: string): Promise<unknown>;
  render(id: string, code: string): Promise<{ svg: string }>;
}

/** Lazy-loaded mermaid instance (2.9M — loaded only when a diagram is encountered) */
let _mermaid: MermaidAPI | null = null;
let _mermaidLoading: Promise<MermaidAPI> | null = null;

async function getMermaid(): Promise<MermaidAPI> {
  if (_mermaid) return _mermaid;
  if (_mermaidLoading) return _mermaidLoading;

  _mermaidLoading = new Promise<MermaidAPI>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'mermaid.min.js';
    script.onload = () => {
      const m = (window as unknown as { mermaid: MermaidAPI }).mermaid;
      m.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#0969da',
          primaryTextColor: '#d4d4d4',
          primaryBorderColor: '#30363d',
          lineColor: '#6e7681',
          secondaryColor: '#1f6feb',
          tertiaryColor: '#2d333b'
        }
      });
      _mermaid = m;
      resolve(m);
    };
    script.onerror = () => reject(new Error('Failed to load mermaid.min.js'));
    document.head.appendChild(script);
  });

  return _mermaidLoading;
}

declare const marked: {
  use(options: { renderer: object }): void;
  parse(markdown: string): string;
};

declare const DOMPurify: {
  sanitize(html: string, config: object): string;
};

declare const hljs: {
  highlightAll(): void;
  highlightElement(element: HTMLElement): void;
} | undefined;

/**
 * DOMPurify configuration for sanitizing markdown content
 * These lists prevent XSS attacks and ID collisions with app UI elements
 */
const FORBIDDEN_ATTRS = [
  // Prevent ID collisions with app UI elements (chat content shouldn't have IDs)
  'id',
  // JavaScript event handlers
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover',
  'onmousemove', 'onmouseout', 'onmouseenter', 'onmouseleave',
  'onkeydown', 'onkeyup', 'onkeypress',
  'onfocus', 'onblur', 'onchange', 'oninput', 'onsubmit', 'onreset',
  'onload', 'onerror', 'onabort', 'onbeforeunload', 'onunload',
  'onresize', 'onscroll', 'onwheel',
  'oncopy', 'oncut', 'onpaste',
  'ondrag', 'ondragstart', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover', 'ondrop',
  'oncontextmenu', 'onshow', 'ontoggle',
  'onanimationstart', 'onanimationend', 'onanimationiteration',
  'ontransitionend', 'onpointerdown', 'onpointerup', 'onpointermove'
];

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form', 
  'input', 'button', 'textarea', 'select', 'option'
];

/**
 * Configure marked to handle mermaid code blocks
 */
function configureMarked(): void {
  marked.use({
    renderer: {
      code(code: string, language: string): string {
        if (language === 'mermaid') {
          const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
          return `<div class="mermaid-diagram" data-mermaid-id="${id}">${code}</div>`;
        }
        const langClass = language ? `language-${language}` : '';
        return `<pre><code class="hljs ${langClass}">${code}</code></pre>`;
      }
    }
  });
}

/**
 * Render mermaid diagrams found within a container element.
 * Async — replaces diagram source text with rendered SVG.
 */
async function renderMermaidIn(container: Element): Promise<void> {
  const mermaidDivs = container.querySelectorAll<HTMLElement>('.mermaid-diagram');
  if (mermaidDivs.length === 0) return;

  // Lazy-load mermaid only when a diagram is actually encountered
  let m: MermaidAPI;
  try {
    m = await getMermaid();
  } catch (err) {
    console.error('Mermaid load failed:', err);
    for (const div of mermaidDivs) {
      div.innerHTML = '<pre class="mermaid-error">Mermaid failed to load</pre>';
    }
    return;
  }

  for (const div of mermaidDivs) {
    const code = div.textContent ?? '';
    const mermaidId = div.dataset.mermaidId || 'mermaid-fallback';

    // Validate first — parse() throws on bad syntax without injecting
    // error SVGs into document.body (unlike render()).
    try {
      await m.parse(code);
    } catch {
      div.innerHTML = '<pre class="mermaid-error">Invalid diagram syntax</pre>';
      continue;
    }

    try {
      const { svg } = await m.render(mermaidId + '-svg', code);
      div.innerHTML = svg;
    } catch (error) {
      console.error('Mermaid rendering error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      div.innerHTML = `<pre class="mermaid-error">Error rendering diagram: ${message}</pre>`;
    }
  }
}

/**
 * Render markdown in all marked elements
 */
async function renderMarkdown(): Promise<void> {
  const markdownElements = regions.chat.queryAll('[data-markdown]');
  
  for (const element of markdownElements) {
    const el = element as HTMLElement;
    
    // Skip if already processed
    if (el.dataset.markdownProcessed === 'true') continue;
    
    // Process ALL .markdown-content divs (multi-turn creates multiple)
    const contentDivs = el.querySelectorAll('.markdown-content');
    if (contentDivs.length === 0) continue;
    
    for (const contentDiv of contentDivs) {
      // Skip if this specific div is already rendered (has HTML children)
      if (contentDiv.querySelector('p, h1, h2, h3, ul, ol, pre, blockquote')) continue;
      
      // Get the escaped text content
      const markdownText = contentDiv.textContent ?? '';
      if (!markdownText.trim()) continue;
      
      // Parse markdown
      const rawHtml = marked.parse(markdownText);
      
      // Sanitize HTML to prevent XSS attacks
      const html = DOMPurify.sanitize(rawHtml, {
        FORBID_ATTR: FORBIDDEN_ATTRS,
        FORBID_TAGS: FORBIDDEN_TAGS
      });
      
      // Update content
      contentDiv.innerHTML = html;
      
      // Render any Mermaid diagrams
      await renderMermaidIn(contentDiv);
    }
    
    // Mark parent as processed
    el.dataset.markdownProcessed = 'true';
  }
  
  // Apply syntax highlighting to code blocks inside chat only
  // (avoid corrupting other page elements like context footer)
  if (typeof hljs !== 'undefined') {
    for (const block of regions.chat.queryAll('pre code')) {
      hljs.highlightElement(block as HTMLElement);
    }
  }
}

/**
 * Render markdown for a single element (for incremental streaming)
 * Unlike renderMarkdown(), this doesn't mark as processed and skips mermaid/hljs
 * for performance during streaming.
 * 
 * @param element - Element containing markdown text (uses element directly, not a child)
 */
export function renderMarkdownElement(element: Element): void {
  const markdownText = element.textContent ?? '';
  if (!markdownText.trim()) return;
  
  // Parse markdown
  const rawHtml = marked.parse(markdownText);
  
  // Sanitize HTML
  const html = DOMPurify.sanitize(rawHtml, {
    FORBID_ATTR: FORBIDDEN_ATTRS,
    FORBID_TAGS: FORBIDDEN_TAGS
  });
  
  // Update content (keep streaming cursor if present)
  const hadCursor = element.classList.contains('streaming-cursor');
  element.innerHTML = html;
  // Add markdown-content class for CSS styling (lists, headings, etc.)
  element.classList.add('markdown-content');
  if (hadCursor) {
    element.classList.add('streaming-cursor');
  }

  // Render mermaid only when all code fences are closed.
  // Odd fence count = mid-block (incomplete diagram text) → skip.
  // Even fence count = all blocks closed → safe to render.
  const fenceCount = (markdownText.match(/^```/gm) || []).length;
  if (fenceCount % 2 === 0) {
    void renderMermaidIn(element);
  }
}

/**
 * Set up markdown rendering
 */
export function setupMarkdownRenderer(): void {
  configureMarked();
  
  // Export to window for other modules
  window.renderMarkdown = renderMarkdown;
  window.renderMarkdownElement = renderMarkdownElement;
  
  // Render markdown when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void renderMarkdown());
  } else {
    void renderMarkdown();
  }
}
