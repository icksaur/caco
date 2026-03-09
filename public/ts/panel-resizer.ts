const MIN_WIDTH = 250;

function setupResizer(resizerId: string, panelId: string, storageKey: string, direction: 'left' | 'right'): void {
  const resizer = document.getElementById(resizerId);
  const panel = document.getElementById(panelId);
  if (!resizer || !panel) return;

  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.width = saved;

  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = direction === 'right' ? startX - e.clientX : e.clientX - startX;
    const newWidth = Math.max(MIN_WIDTH, startWidth + delta);
    const maxWidth = window.innerWidth * 0.8;
    panel.style.width = `${Math.min(newWidth, maxWidth)}px`;
  };

  const onMouseUp = () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    localStorage.setItem(storageKey, panel.style.width);
  };

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

export function initPanelResizer(): void {
  setupResizer('panelResizer', 'appletPanel', 'caco:appletPanelWidth', 'right');
  setupResizer('sessionResizer', 'sessionView', 'caco:sessionPanelWidth', 'left');
}
