/**
 * Markdown rendering with Mermaid diagrams and syntax highlighting
 */

declare const mermaid: {
  initialize(config: object): void;
  render(id: string, code: string): Promise<{ svg: string }>;
};

declare const marked: {
  use(options: { renderer: object }): void;
  parse(markdown: string): string;
};

declare const DOMPurify: {
  sanitize(html: string, config: object): string;
};

declare const hljs: {
  highlightAll(): void;
} | undefined;

// HTMX and event handler attributes to block
const FORBIDDEN_ATTRS = [
  // HTMX attributes - prevent injected HTMX from executing
  'hx-get', 'hx-post', 'hx-put', 'hx-delete', 'hx-patch',
  'hx-trigger', 'hx-target', 'hx-swap', 'hx-vals', 'hx-sync',
  'hx-confirm', 'hx-boost', 'hx-push-url', 'hx-on', 'hx-ext',
  'hx-include', 'hx-indicator', 'hx-params', 'hx-request',
  'hx-select', 'hx-select-oob', 'hx-swap-oob', 'hx-preserve',
  'hx-prompt', 'hx-replace-url', 'hx-disable', 'hx-disabled-elt',
  'hx-disinherit', 'hx-encoding', 'hx-headers', 'hx-history',
  'hx-history-elt', 'hx-inherit', 'hx-validate',
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
 * Initialize Mermaid with dark theme
 */
function initMermaid(): void {
  mermaid.initialize({ 
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
}

/**
 * Configure marked to handle mermaid code blocks
 */
function configureMarked(): void {
  marked.use({
    renderer: {
      code(code: string, language: string): string {
        if (language === 'mermaid') {
          const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
          return `<div class="mermaid-diagram" id="${id}">${code}</div>`;
        }
        const langClass = language ? `language-${language}` : '';
        return `<pre><code class="hljs ${langClass}">${code}</code></pre>`;
      }
    }
  });
}

/**
 * Render markdown in all marked elements
 */
async function renderMarkdown(): Promise<void> {
  const markdownElements = document.querySelectorAll('[data-markdown]');
  
  for (const element of markdownElements) {
    const el = element as HTMLElement;
    
    // Skip if already processed
    if (el.dataset.markdownProcessed === 'true') continue;
    
    const contentDiv = el.querySelector('.markdown-content');
    if (!contentDiv) continue;
    
    // Get the escaped text content
    const markdownText = contentDiv.textContent ?? '';
    
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
    const mermaidDivs = contentDiv.querySelectorAll('.mermaid-diagram');
    for (const div of mermaidDivs) {
      try {
        const { svg } = await mermaid.render(div.id + '-svg', div.textContent ?? '');
        div.innerHTML = svg;
      } catch (error) {
        console.error('Mermaid rendering error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        div.innerHTML = `<pre class="mermaid-error">Error rendering diagram: ${message}</pre>`;
      }
    }
    
    // Mark as processed
    el.dataset.markdownProcessed = 'true';
  }
  
  // Apply syntax highlighting to all code blocks
  if (typeof hljs !== 'undefined') {
    hljs.highlightAll();
  }
}

/**
 * Set up markdown rendering
 */
export function setupMarkdownRenderer(): void {
  initMermaid();
  configureMarked();
  
  // Render markdown when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderMarkdown);
  } else {
    renderMarkdown();
  }
  
  // Also render after htmx swaps new content
  document.body.addEventListener('htmx:afterSwap', renderMarkdown);
}
