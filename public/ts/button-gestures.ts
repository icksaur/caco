/**
 * Unified button gesture handling
 * 
 * Provides consistent input handling across mouse and touch devices.
 * Prevents the "ghost click" problem where touch events fire both touch and mouse events.
 * 
 * Usage:
 *   // Simple click
 *   onButton('myBtn', { onPress: () => doSomething() });
 *   
 *   // With long-press
 *   onButton('myBtn', { 
 *     onPress: () => toggle(),
 *     onLongPress: () => openMenu(),
 *     longPressDuration: 1000 
 *   });
 */

export interface ButtonGestureOptions {
  /** Called on short press (click/tap) */
  onPress?: () => void;
  /** Called when long press threshold is reached */
  onLongPress?: () => void;
  /** Duration in ms to trigger long press (default: 1000) */
  longPressDuration?: number;
}

/**
 * Attach unified gesture handling to a button
 * Handles mouse and touch events, preventing ghost clicks
 */
export function onButton(
  elementOrId: HTMLElement | string,
  options: ButtonGestureOptions
): void {
  const btn = typeof elementOrId === 'string' 
    ? document.getElementById(elementOrId) 
    : elementOrId;
  
  if (!btn) return;
  
  const { onPress, onLongPress, longPressDuration = 1000 } = options;
  
  // If no long-press needed, use simple click (already touch-safe)
  if (!onLongPress) {
    if (onPress) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        onPress();
      });
    }
    return;
  }
  
  // Long-press mode: need separate mouse/touch handling
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = false;
  
  function startPress(): void {
    longPressTriggered = false;
    pressTimer = setTimeout(() => {
      longPressTriggered = true;
      onLongPress?.();
    }, longPressDuration);
  }
  
  function cancelPress(): void {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }
  
  function endPress(): void {
    cancelPress();
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    onPress?.();
  }
  
  // Mouse events
  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('mouseup', endPress);
  btn.addEventListener('mouseleave', cancelPress);
  
  // Touch events - preventDefault to avoid synthesized mouse events
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startPress();
  });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    endPress();
  });
  btn.addEventListener('touchcancel', cancelPress);
  
  // Prevent context menu on long press
  btn.addEventListener('contextmenu', (e) => {
    if (longPressTriggered) {
      e.preventDefault();
    }
  });
}
