/**
 * Applet button initialization
 * Uses shared button-gestures for consistent input handling
 */

import { onButton } from './button-gestures.js';

export interface AppletButtonCallbacks {
  onPress: () => void;
  onLongPress: () => void;
}

/**
 * Initialize applet button with gesture detection
 * @param callbacks - handlers for press and long-press gestures
 */
export function initAppletButton(callbacks: AppletButtonCallbacks): void {
  onButton('appletBtn', {
    onPress: callbacks.onPress,
    onLongPress: callbacks.onLongPress,
    longPressDuration: 1000
  });
}
