const STORAGE_KEY = 'caco:appletPanelWidth';
const MIN_WIDTH = 300;

export function initPanelResizer(): void {
  const resizer = document.getElementById('panelResizer');
  const panel = document.getElementById('appletPanel');
  if (!resizer || !panel) return;

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) panel.style.width = saved;

  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = startX - e.clientX;
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
    localStorage.setItem(STORAGE_KEY, panel.style.width);
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
