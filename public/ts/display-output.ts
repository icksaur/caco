/**
 * Display output rendering for display-only tools
 * 
 * Rendering is driven by metadata, not explicit types.
 * To add a new output type, just store the right metadata on the server.
 * 
 * Rendering rules (checked in order):
 * 1. metadata.type === 'embed' or metadata.html → render as sanitized HTML (embeds, iframes)
 * 2. metadata.mimeType starts with 'image/' → render as image
 * 3. metadata.command exists → render as terminal output
 * 4. metadata.path exists → render as code file
 * 5. fallback → render data as preformatted text
 */

import type { OutputData } from './types.js';
import { buildTerminalMarkdown, buildCodeMarkdown } from './markdown-builders.js';

// Declare globals from external scripts
declare global {
  interface Window {
    marked?: { parse: (md: string) => string };
    DOMPurify?: { sanitize: (html: string, config?: Record<string, unknown>) => string };
    hljs?: { highlightElement: (el: Element) => void };
  }
}

// Minimal output info needed for rendering
interface OutputRef {
  id: string;
  // Type is optional - we infer from metadata
  type?: string;
}

/**
 * Render display output from display-only tools
 * Rendering is driven by metadata, making it easy to add new output types.
 */
export async function renderDisplayOutput(output: OutputRef): Promise<void> {
  if (!output?.id) return;
  
  const container = document.querySelector('#pending-response .outputs-container');
  if (!container) return;
  
  try {
    const response = await fetch(`/api/outputs/${output.id}?format=json`);
    if (!response.ok) return;
    
    const { data, metadata }: OutputData = await response.json();
    
    // Dispatch based on metadata (order matters)
    if (metadata.type === 'embed' || metadata.html) {
      renderEmbed(container, data, metadata);
    } else if (metadata.mimeType?.startsWith('image/')) {
      renderImage(container, output.id, data, metadata);
    } else if (metadata.command !== undefined) {
      renderTerminal(container, data, metadata);
    } else if (metadata.path) {
      renderCode(container, data, metadata);
    } else {
      // Fallback: render as preformatted text
      renderPreformatted(container, data);
    }
  } catch (err) {
    console.error('Error displaying output:', err);
  }
}

/**
 * Render embedded HTML content (YouTube, SoundCloud, etc.)
 */
function renderEmbed(container: Element, data: string, metadata: OutputData['metadata']): void {
  const div = document.createElement('div');
  div.className = 'output-embed';
  
  // Use html field if present, otherwise use data directly
  const html = metadata.html || data;
  
  if (window.DOMPurify) {
    div.innerHTML = window.DOMPurify.sanitize(html, {
      ADD_TAGS: ['iframe'],
      ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'src', 'width', 'height']
    });
  } else {
    div.innerHTML = html;
  }
  
  container.appendChild(div);
}

/**
 * Render image content
 */
function renderImage(container: Element, outputId: string, data: string, metadata: OutputData['metadata']): void {
  const img = document.createElement('img');
  img.className = 'output-image';
  img.src = metadata.mimeType && typeof data === 'string'
    ? `data:${metadata.mimeType};base64,${data}`
    : `/api/outputs/${outputId}`;
  img.alt = metadata.path || 'Image';
  container.appendChild(img);
}

/**
 * Render terminal/command output
 */
function renderTerminal(container: Element, data: string, metadata: OutputData['metadata']): void {
  const markdown = buildTerminalMarkdown({
    command: metadata.command || '',
    exitCode: metadata.exitCode,
    output: data
  });
  renderMarkdown(container, markdown, 'output-terminal');
}

/**
 * Render code/file content
 */
function renderCode(container: Element, data: string, metadata: OutputData['metadata']): void {
  const markdown = buildCodeMarkdown({
    data,
    path: metadata.path,
    highlight: metadata.highlight,
    startLine: metadata.startLine,
    endLine: metadata.endLine,
    totalLines: metadata.totalLines
  });
  renderMarkdown(container, markdown, 'output-code');
}

/**
 * Render preformatted text (fallback)
 */
function renderPreformatted(container: Element, data: string): void {
  const pre = document.createElement('pre');
  pre.className = 'output-raw';
  pre.textContent = data;
  container.appendChild(pre);
}

/**
 * Helper: render markdown and append to container
 */
function renderMarkdown(container: Element, markdown: string, className: string): void {
  if (!window.marked || !window.DOMPurify) {
    // Fallback to preformatted
    renderPreformatted(container, markdown);
    return;
  }
  
  const div = document.createElement('div');
  div.className = `output-content ${className}`;
  div.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown));
  container.appendChild(div);
  
  // Apply syntax highlighting
  div.querySelectorAll('pre code').forEach((block) => {
    if (window.hljs) window.hljs.highlightElement(block);
  });
}

/**
 * Restore outputs from history after page reload
 * 
 * Looks for data-outputs attribute on messages and renders them.
 * Called after history HTML is loaded into the chat container.
 */
export async function restoreOutputsFromHistory(): Promise<void> {
  const chat = document.getElementById('chat');
  if (!chat) return;
  
  // Find messages with data-outputs attribute
  const messagesWithOutputs = chat.querySelectorAll('.message[data-outputs]');
  
  for (const message of messagesWithOutputs) {
    const outputIds = message.getAttribute('data-outputs')?.split(',').filter(Boolean);
    if (!outputIds || outputIds.length === 0) continue;
    
    // Create outputs container for this message
    let outputsContainer = message.querySelector('.outputs-container');
    if (!outputsContainer) {
      outputsContainer = document.createElement('div');
      outputsContainer.className = 'outputs-container';
      // Insert before markdown content
      const markdownContent = message.querySelector('.markdown-content');
      if (markdownContent) {
        message.insertBefore(outputsContainer, markdownContent);
      } else {
        message.appendChild(outputsContainer);
      }
    }
    
    // Render each output
    for (const outputId of outputIds) {
      await renderOutputById(outputId, outputsContainer);
    }
  }
}

/**
 * Render an output by ID into a container
 * Exported for live streaming - called when output message arrives via WS
 */
export async function renderOutputById(outputId: string, container: Element): Promise<void> {
  try {
    const response = await fetch(`/api/outputs/${outputId}?format=json`);
    if (!response.ok) {
      console.warn(`Output ${outputId} not found (may have expired)`);
      return;
    }
    
    const { data, metadata } = await response.json();
    
    // Dispatch based on metadata (same logic as renderDisplayOutput)
    if (metadata.type === 'embed' || metadata.html) {
      renderEmbed(container, data, metadata);
    } else if (metadata.mimeType?.startsWith('image/')) {
      renderImage(container, outputId, data, metadata);
    } else if (metadata.command !== undefined) {
      renderTerminal(container, data, metadata);
    } else if (metadata.path) {
      renderCode(container, data, metadata);
    } else {
      renderPreformatted(container, data);
    }
  } catch (err) {
    console.error(`Error restoring output ${outputId}:`, err);
  }
}
