let permissionGranted = false;

export function initNotifications(): void {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    permissionGranted = true;
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { permissionGranted = p === 'granted'; });
  }
}

export function notifySessionComplete(title: string): void {
  if (!permissionGranted) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;

  const n = new Notification('Caco', {
    body: title || 'Session complete',
    icon: '/caco.png',
    tag: 'caco-idle',
  });
  n.onclick = () => { window.focus(); n.close(); };
  setTimeout(() => n.close(), 8000);
}
