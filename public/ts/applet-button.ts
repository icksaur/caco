/**
 * Applet button gesture handling
 * Separates input gesture logic from navigation concerns
 */

export interface AppletButtonCallbacks {
  onPress: () => void;
  onLongPress: () => void;
}

const LONG_PRESS_DURATION = 1000; // 1 second

/**
 * Initialize applet button with gesture detection
 * @param callbacks - handlers for press and long-press gestures
 */
export function initAppletButton(callbacks: AppletButtonCallbacks): void {
  const btn = document.getElementById('appletBtn');
  if (!btn) return;
  
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = false;
  
  function startPress(): void {
    longPressTriggered = false;
    pressTimer = setTimeout(() => {
      longPressTriggered = true;
      callbacks.onLongPress();
    }, LONG_PRESS_DURATION);
  }
  
  function cancelPress(): void {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }
  
  function endPress(): void {
    cancelPress();
    // If long press was triggered, don't fire normal press
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    callbacks.onPress();
  }
  
  // Mouse events
  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('mouseup', endPress);
  btn.addEventListener('mouseleave', cancelPress);
  
  // Touch events
  btn.addEventListener('touchstart', startPress);
  btn.addEventListener('touchend', endPress);
  btn.addEventListener('touchcancel', cancelPress);
  
  // Prevent context menu on long press
  btn.addEventListener('contextmenu', (e) => {
    if (longPressTriggered) {
      e.preventDefault();
    }
  });
}
