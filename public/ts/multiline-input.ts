/**
 * Multiline Input
 * 
 * Auto-expanding textarea for chat input.
 * - Enter submits the form
 * - Shift+Enter adds a newline
 * - Auto-expands up to max height, then scrolls
 */

const MIN_HEIGHT = 42;  // ~1 line
const MAX_HEIGHT = 180; // ~6 lines

/**
 * Set up multiline input behavior on the chat textarea
 */
export function setupMultilineInput(): void {
  const textarea = document.querySelector('#chatForm textarea[name="message"]') as HTMLTextAreaElement;
  if (!textarea) return;
  
  // Auto-resize on input
  textarea.addEventListener('input', () => {
    autoResize(textarea);
  });
  
  // Handle Enter vs Shift+Enter
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = textarea.closest('form');
      if (form) {
        form.requestSubmit();
      }
    }
    // Shift+Enter: default behavior (newline) - no action needed
  });
  
  // Initial sizing
  autoResize(textarea);
}

/**
 * Auto-resize textarea to fit content
 */
function autoResize(textarea: HTMLTextAreaElement): void {
  // Reset to min to get accurate scrollHeight
  textarea.style.height = 'auto';
  
  // Calculate new height
  const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
  textarea.style.height = `${newHeight}px`;
  
  // Show scrollbar only when at max
  textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
}

/**
 * Reset textarea to single line (call after submit)
 */
export function resetTextareaHeight(): void {
  const textarea = document.querySelector('#chatForm textarea[name="message"]') as HTMLTextAreaElement;
  if (textarea) {
    textarea.style.height = `${MIN_HEIGHT}px`;
    textarea.style.overflowY = 'hidden';
  }
}
