import { fuzzyScore } from './ui-utils.js';

export interface PopupItem {
  id: string;
  label: string;
  description?: string;
  value?: string;
  icon?: string;
  danger?: boolean;
}

interface InputPopupConfig {
  anchor: HTMLElement;
  onSelect: (item: PopupItem) => void;
  onDismiss: () => void;
  direction?: 'up' | 'down';
}

export class InputPopup {
  private el: HTMLDivElement;
  private config: InputPopupConfig;
  private items: PopupItem[] = [];
  private filtered: PopupItem[] = [];
  private selectedIdx = 0;
  private globalClickHandler: ((e: MouseEvent) => void) | null = null;
  private globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(config: InputPopupConfig) {
    this.config = config;
    this.el = document.createElement('div');
    this.el.className = 'input-popup';
    this.el.style.display = 'none';
    this.el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = (e.target as HTMLElement).closest('.input-popup-item') as HTMLElement;
      if (!target?.dataset.idx) return;
      const idx = Number(target.dataset.idx);
      if (this.filtered[idx]) this.config.onSelect(this.filtered[idx]);
    });
    this.el.addEventListener('mouseover', (e) => {
      const target = (e.target as HTMLElement).closest('.input-popup-item') as HTMLElement;
      if (!target?.dataset.idx) return;
      const idx = Number(target.dataset.idx);
      if (idx !== this.selectedIdx) {
        this.selectedIdx = idx;
        this.el.querySelectorAll('.input-popup-item').forEach((el, i) => {
          el.classList.toggle('selected', i === idx);
        });
      }
    });
    document.body.appendChild(this.el);
  }

  show(items: PopupItem[]): void {
    this.items = items;
    this.filtered = items;
    this.selectedIdx = 0;
    this.render();
    this.position();
    this.el.style.display = '';
    this.addGlobalListeners();
  }

  hide(): void {
    this.el.style.display = 'none';
    this.filtered = [];
    this.items = [];
    this.removeGlobalListeners();
  }

  isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  filter(query: string): void {
    if (!query) {
      this.filtered = this.items;
    } else {
      const q = query.toLowerCase();
      this.filtered = this.items
        .map(item => {
          const labelScore = fuzzyScore(item.label.toLowerCase(), q);
          const descScore = item.description ? fuzzyScore(item.description.toLowerCase(), q) : 0;
          return { item, score: Math.max(labelScore, descScore) };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.item);
    }
    this.selectedIdx = 0;
    if (this.filtered.length === 0) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this.render();
    this.position();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.isVisible()) return false;
    // No items to navigate — let the textarea handle the key. Otherwise we
    // swallow arrow keys with no visible feedback.
    if (this.filtered.length === 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Tab')) {
      return false;
    }

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

  private addGlobalListeners(): void {
    this.removeGlobalListeners();
    this.globalClickHandler = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node)) {
        this.config.onDismiss();
      }
    };
    this.globalKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.config.onDismiss();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this.globalClickHandler!);
      document.addEventListener('keydown', this.globalKeyHandler!);
    }, 0);
  }

  private removeGlobalListeners(): void {
    if (this.globalClickHandler) {
      document.removeEventListener('mousedown', this.globalClickHandler);
      this.globalClickHandler = null;
    }
    if (this.globalKeyHandler) {
      document.removeEventListener('keydown', this.globalKeyHandler);
      this.globalKeyHandler = null;
    }
  }

  destroy(): void {
    this.el.remove();
  }

  private position(): void {
    const rect = this.config.anchor.getBoundingClientRect();
    this.el.style.left = `${rect.left}px`;
    this.el.style.width = `${rect.width}px`;
    if (this.config.direction === 'down') {
      this.el.style.top = `${rect.bottom}px`;
      this.el.style.bottom = 'auto';
    } else {
      this.el.style.bottom = `${window.innerHeight - rect.top}px`;
      this.el.style.top = 'auto';
    }
  }

  private render(): void {
    this.el.innerHTML = '';
    for (let i = 0; i < this.filtered.length; i++) {
      const item = this.filtered[i];
      const div = document.createElement('div');
      div.className = 'input-popup-item' + (i === this.selectedIdx ? ' selected' : '') + (item.danger ? ' danger' : '');
      div.dataset.idx = String(i);
      if (item.icon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'popup-icon ' + item.icon;
        div.appendChild(iconEl);
      }
      const labelEl = document.createTextNode(item.label);
      div.appendChild(labelEl);
      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'popup-description';
        desc.textContent = item.description;
        div.appendChild(desc);
      }
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
