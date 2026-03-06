/**
 * Swarm Progress Widget
 *
 * Listens for adhoc.swarmProgress global events and shows a progress bar
 * in the ad-hoc bar for the parent session.
 */

import { adHocBar, type AdHocWidgetHandle } from './adhoc-bar.js';
import { onGlobalEvent } from './websocket.js';

interface SwarmState {
  completed: number;
  total: number;
  handle: AdHocWidgetHandle;
}

const activeSwarms = new Map<string, SwarmState>();

function renderProgress(completed: number, total: number): HTMLElement {
  const container = document.createElement('div');
  container.className = 'swarm-progress';

  const filled = total > 0 ? Math.round((completed / total) * 10) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  container.innerHTML =
    `<span class="swarm-bar">${bar}</span>` +
    `<span class="swarm-label">swarm ${completed}/${total}</span>`;

  return container;
}

export function setupSwarmProgress(): void {
  onGlobalEvent((event) => {
    if (event.type !== 'adhoc.swarmProgress') return;
    const { sessionId, completed, total } = event.data as {
      sessionId: string;
      completed: number;
      total: number;
    };

    const existing = activeSwarms.get(sessionId);

    if (completed >= total) {
      // Swarm complete — remove widget
      if (existing) {
        existing.handle.remove();
        activeSwarms.delete(sessionId);
      }
      return;
    }

    if (existing) {
      existing.completed = completed;
      existing.total = total;
      existing.handle.update();
    } else {
      const state: SwarmState = { completed, total, handle: null! };
      const handle = adHocBar.addWidget(sessionId, {
        id: 'swarm-progress',
        priority: 10,
        render: () => renderProgress(state.completed, state.total),
      });
      state.handle = handle;
      activeSwarms.set(sessionId, state);
    }
  });
}
