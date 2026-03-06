/**
 * Ad-Hoc Bar Manager
 *
 * Session-scoped widget region above the chat input.
 * Widgets are programmatically added/removed — no user dismiss.
 * Session idle clears the bar as a lost-bar precaution.
 */

const MAX_WIDGETS = 10;

export interface AdHocWidget {
  id: string;
  priority: number;
  render: () => HTMLElement;
  dispose?: () => void;
}

export interface AdHocWidgetHandle {
  update(): void;
  remove(): void;
}

class AdHocBarManager {
  private widgetsBySession = new Map<string, Map<string, AdHocWidget>>();
  private activeSessionId: string | null = null;
  private containerEl: HTMLElement | null = null;

  init(container: HTMLElement): void {
    this.containerEl = container;
  }

  addWidget(sessionId: string, widget: AdHocWidget): AdHocWidgetHandle {
    let sessionWidgets = this.widgetsBySession.get(sessionId);
    if (!sessionWidgets) {
      sessionWidgets = new Map();
      this.widgetsBySession.set(sessionId, sessionWidgets);
    }

    if (sessionWidgets.size >= MAX_WIDGETS && !sessionWidgets.has(widget.id)) {
      console.warn(`[ADHOC] Widget cap (${MAX_WIDGETS}) reached for session ${sessionId.slice(0, 8)}`);
    }

    sessionWidgets.set(widget.id, widget);

    if (sessionId === this.activeSessionId) {
      this.render();
    }

    return {
      update: () => {
        if (sessionId === this.activeSessionId) this.render();
      },
      remove: () => this.removeWidget(sessionId, widget.id),
    };
  }

  removeWidget(sessionId: string, widgetId: string): void {
    const sessionWidgets = this.widgetsBySession.get(sessionId);
    if (!sessionWidgets) return;
    const widget = sessionWidgets.get(widgetId);
    if (widget) {
      widget.dispose?.();
      sessionWidgets.delete(widgetId);
      if (sessionWidgets.size === 0) this.widgetsBySession.delete(sessionId);
    }
    if (sessionId === this.activeSessionId) this.render();
  }

  clearSession(sessionId: string): void {
    const sessionWidgets = this.widgetsBySession.get(sessionId);
    if (!sessionWidgets) return;
    for (const widget of sessionWidgets.values()) {
      widget.dispose?.();
    }
    this.widgetsBySession.delete(sessionId);
    if (sessionId === this.activeSessionId) this.render();
  }

  activateSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.render();
  }

  deactivate(): void {
    this.activeSessionId = null;
    this.render();
  }

  private render(): void {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = '';

    if (!this.activeSessionId) {
      this.containerEl.classList.remove('visible');
      return;
    }

    const sessionWidgets = this.widgetsBySession.get(this.activeSessionId);
    if (!sessionWidgets || sessionWidgets.size === 0) {
      this.containerEl.classList.remove('visible');
      return;
    }

    const sorted = [...sessionWidgets.values()].sort((a, b) => a.priority - b.priority);

    for (const widget of sorted) {
      try {
        const el = widget.render();
        this.containerEl.appendChild(el);
      } catch {
        const placeholder = document.createElement('span');
        placeholder.className = 'adhoc-error';
        placeholder.textContent = `[widget error: ${widget.id}]`;
        this.containerEl.appendChild(placeholder);
      }
    }

    this.containerEl.classList.add('visible');
  }
}

export const adHocBar = new AdHocBarManager();
