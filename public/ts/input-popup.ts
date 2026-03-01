import { fuzzyScore } from './ui-utils.js';

export interface PopupItem {
  id: string;
  label: string;
  description?: string;
  value?: string;
}

interface InputPopupConfig {
  anchor: HTMLElement;
  onSelect: (item: PopupItem) => void;
  onDismiss: () => void;
}

export class InputPopup {
  private el: HTMLDivElement;
  private config: InputPopupConfig;
  private items: PopupItem[] = [];
  private filtered: PopupItem[] = [];
  private selectedIdx = 0;

  constructor(config: InputPopupConfig) {
    this.config = config;
    this.el = document.createElement('div');
    this.el.className = 'input-popup';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  show(items: PopupItem[]): void {
    this.items = items;
    this.filtered = items;
    this.selectedIdx = 0;
    this.render();
    this.position();
    this.el.style.display = '';
  }

  hide(): void {
    this.el.style.display = 'none';
    this.filtered = [];
    this.items = [];
  }

  isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  filter(query: string): void {
    if (!query) {
      this.filtered = this.items;
    } else {
      this.filtered = this.items
        .map(item => ({ item, score: fuzzyScore(item.label.toLowerCase(), query.toLowerCase()) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.item);
    }
    this.selectedIdx = 0;
    this.render();
    this.position();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        this.selectedIdx = Math.min(this.selectedIdx + 1, this.filtered.length - 1);
        this.render();
        this.scrollToSelected();
        return true;
      case 'ArrowUp':
        this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
        this.render();
        this.scrollToSelected();
        return true;
      case 'Enter':
      case 'Tab':
        if (this.filtered.length > 0) {
          this.config.onSelect(this.filtered[this.selectedIdx]);
        }
        return true;
      case 'Escape':
        this.config.onDismiss();
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    this.el.remove();
  }

  private position(): void {
    const rect = this.config.anchor.getBoundingClientRect();
    this.el.style.left = `${rect.left}px`;
    this.el.style.width = `${rect.width}px`;
    this.el.style.bottom = `${window.innerHeight - rect.top}px`;
    this.el.style.top = 'auto';
  }

  private render(): void {
    this.el.innerHTML = '';
    for (let i = 0; i < this.filtered.length; i++) {
      const item = this.filtered[i];
      const div = document.createElement('div');
      div.className = 'input-popup-item' + (i === this.selectedIdx ? ' selected' : '');
      div.textContent = item.label;
      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'popup-description';
        desc.textContent = item.description;
        div.appendChild(desc);
      }
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.config.onSelect(item);
      });
      div.addEventListener('mouseenter', () => {
        this.selectedIdx = i;
        this.render();
      });
      this.el.appendChild(div);
    }
  }

  private scrollToSelected(): void {
    const selected = this.el.querySelector('.selected') as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }
}
