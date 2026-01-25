/**
 * Display output rendering for display-only tools
 */

import type { DisplayOutput, OutputData } from './types.js';

// Declare globals from external scripts
declare global {
  interface Window {
    marked?: { parse: (md: string) => string };
    DOMPurify?: { sanitize: (html: string) => string };
    hljs?: { highlightElement: (el: Element) => void };
  }
}

/**
 * Render display output from display-only tools
 */
export async function renderDisplayOutput(output: DisplayOutput): Promise<void> {
  if (!output || !output.id) return;
  
  const container = document.querySelector('#pending-response .outputs-container');
  if (!container) return;
  
  try {
    const response = await fetch(`/api/outputs/${output.id}?format=json`);
    if (!response.ok) return;
    
    const { data, metadata }: OutputData = await response.json();
    let markdown = '';
    
    if (output.type === 'file') {
      const lang = metadata.highlight || '';
      const pathInfo = metadata.path ? `**${metadata.path}**` : '';
      const lineInfo = metadata.startLine && metadata.endLine 
        ? ` (lines ${metadata.startLine}-${metadata.endLine} of ${metadata.totalLines})`
        : '';
      markdown = `${pathInfo}${lineInfo}\n\n\`\`\`${lang}\n${data}\n\`\`\``;
      
    } else if (output.type === 'terminal') {
      const exitInfo = metadata.exitCode === 0 ? '' : ` (exit ${metadata.exitCode})`;
      markdown = `\`\`\`bash\n$ ${metadata.command}${exitInfo}\n${data}\n\`\`\``;
      
    } else if (output.type === 'image') {
      const img = document.createElement('img');
      img.className = 'output-image';
      img.src = metadata.mimeType && typeof data === 'string'
        ? `data:${metadata.mimeType};base64,${data}`
        : `/api/outputs/${output.id}`;
      img.alt = metadata.path || 'Image';
      container.appendChild(img);
      return;
    }
    
    if (markdown && window.marked && window.DOMPurify) {
      const div = document.createElement('div');
      div.className = 'output-content';
      div.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown));
      container.appendChild(div);
      
      // Apply syntax highlighting
      div.querySelectorAll('pre code').forEach((block) => {
        if (window.hljs) window.hljs.highlightElement(block);
      });
    }
  } catch (err) {
    console.error('Error displaying output:', err);
  }
}
