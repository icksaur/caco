// Initialize Mermaid
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

// Configure marked to handle mermaid code blocks
marked.use({
  renderer: {
    code(code, language) {
      if (language === 'mermaid') {
        const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
        // Return a placeholder that will be rendered by Mermaid
        return `<div class="mermaid-diagram" id="${id}">${code}</div>`;
      }
      // Default code block rendering with highlight.js class
      const langClass = language ? `language-${language}` : '';
      return `<pre><code class="hljs ${langClass}">${code}</code></pre>`;
    }
  }
});

// Function to render markdown in all marked elements
async function renderMarkdown() {
  const markdownElements = document.querySelectorAll('[data-markdown]');
  
  for (const element of markdownElements) {
    // Skip if already processed
    if (element.dataset.markdownProcessed === 'true') continue;
    
    const contentDiv = element.querySelector('.markdown-content');
    if (!contentDiv) continue;
    
    // Get the escaped text content
    const markdownText = contentDiv.textContent;
    
    // Parse markdown
    const rawHtml = marked.parse(markdownText);
    
    // Sanitize HTML to prevent XSS attacks (especially HTMX injection)
    const html = DOMPurify.sanitize(rawHtml, {
      FORBID_ATTR: [
        // HTMX attributes - prevent injected HTMX from executing
        'hx-get', 'hx-post', 'hx-put', 'hx-delete', 'hx-patch',
        'hx-trigger', 'hx-target', 'hx-swap', 'hx-vals', 'hx-sync',
        'hx-confirm', 'hx-boost', 'hx-push-url', 'hx-on', 'hx-ext',
        'hx-include', 'hx-indicator', 'hx-params', 'hx-request',
        // JavaScript event handlers
        'onclick', 'onerror', 'onload', 'onmouseover', 'onfocus',
        'onblur', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup'
      ],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button']
    });
    
    // Update content
    contentDiv.innerHTML = html;
    
    // Render any Mermaid diagrams
    const mermaidDivs = contentDiv.querySelectorAll('.mermaid-diagram');
    for (const div of mermaidDivs) {
      try {
        const { svg } = await mermaid.render(div.id + '-svg', div.textContent);
        div.innerHTML = svg;
      } catch (error) {
        console.error('Mermaid rendering error:', error);
        div.innerHTML = `<pre class="mermaid-error">Error rendering diagram: ${error.message}</pre>`;
      }
    }
    
    // Mark as processed
    element.dataset.markdownProcessed = 'true';
  }
  
  // Apply syntax highlighting to all code blocks
  if (typeof hljs !== 'undefined') {
    hljs.highlightAll();
  }
}

// Render markdown when DOM is ready
document.addEventListener('DOMContentLoaded', renderMarkdown);

// Also render after htmx swaps new content
document.body.addEventListener('htmx:afterSwap', renderMarkdown);
