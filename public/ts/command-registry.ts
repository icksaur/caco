import { newSessionClick, sessionClick } from './router.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
import { sortSessions } from './ui-utils.js';
import { deleteSession, renameSession } from './session-panel.js';
import type { PopupItem } from './input-popup.js';
import type { SessionData, SessionsResponse } from './types.js';

export interface Command {
  name: string;
  description: string;
  source: 'built-in' | 'template' | 'extension';
  handler: (args: string) => void | Promise<void>;
  picker?: () => PopupItem[] | Promise<PopupItem[]>;
}

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.name, cmd);
  return () => { commands.delete(cmd.name); };
}

export function getCommands(): Command[] {
  return [...commands.values()];
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name);
}

registerCommand({
  name: 'new',
  description: 'New chat',
  source: 'built-in',
  handler: () => newSessionClick()
});

async function fetchSessionPicker(): Promise<PopupItem[]> {
  try {
    const res = await fetch('/api/sessions');
    const data: SessionsResponse = await res.json();
    const sessions: SessionData[] = Object.values(data.grouped).flat()
      .filter(s => s.kind !== 'swarm' || s.isBusy);
    sortSessions(sessions);
    return sessions.map(s => {
      const label = s.name || s.summary || s.sessionId.slice(0, 8);
      const desc = s.currentIntent || s.cwd?.split('/').pop() || '';
      const icon = s.isBusy ? 'session-busy' : s.isUnobserved ? 'session-unobserved' : '';
      return { id: s.sessionId, label, description: desc, icon };
    });
  } catch { return []; }
}

registerCommand({
  name: 'session-rename',
  description: 'Rename a session',
  source: 'built-in',
  picker: fetchSessionPicker,
  handler: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    const data = await res.json();
    const currentName = data?.meta?.name || data?.meta?.summary || sessionId.slice(0, 8);
    await renameSession(sessionId, currentName);
  }
});

registerCommand({
  name: 'session-delete',
  description: 'Delete a session',
  source: 'built-in',
  picker: fetchSessionPicker,
  handler: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    const data = await res.json();
    const name = data?.meta?.name || data?.meta?.summary || sessionId.slice(0, 8);
    await deleteSession(sessionId, name);
  }
});

registerCommand({
  name: 'sessions',
  description: 'Switch session',
  source: 'built-in',
  picker: fetchSessionPicker,
  handler: (sessionId) => { void sessionClick(sessionId); }
});

registerCommand({
  name: 'model',
  description: 'Change session model',
  source: 'built-in',
  picker: () => {
    const models = getAvailableModels();
    return models.map(m => {
      const cost = m.cost === 0 ? 'free' : `${m.cost}x`;
      return { id: m.id, label: m.name, description: cost };
    });
  },
  handler: async (modelId) => {
    const sessionId = getActiveSessionId();
    if (sessionId) {
      // Active session: change model via SDK
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId })
      });
      if (res.ok) {
        chatView.updateStatus(chatView.getCwd(), modelId);
        showToast(`Model changed to ${modelId}`, { type: 'success', autoHideMs: 3000 });
      } else {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        showToast(data.error || 'Failed to change model');
      }
    } else {
      // New chat: just update the model selector
      selectModel(modelId);
      showToast(`Model changed to ${modelId}`, { type: 'success', autoHideMs: 3000 });
    }
  }
});

registerCommand({
  name: 'restart',
  description: 'Restart the Caco server',
  source: 'built-in',
  handler: async () => {
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, { type: 'info', autoHideMs: 3000 });
    } catch {
      showToast('Failed to restart server');
    }
  }
});

registerCommand({
  name: 'exportsession',
  description: 'Export current session as .tar.gz',
  source: 'built-in',
  handler: async () => {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      showToast('No active session');
      return;
    }
    // Trigger browser download via hidden anchor
    const a = document.createElement('a');
    a.href = `/api/sessions/${sessionId}/export`;
    a.download = `${sessionId}.caco-session.tar.gz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Exporting session...', { type: 'info', autoHideMs: 3000 });
  }
});

registerCommand({
  name: 'compact',
  description: 'Force context compaction',
  source: 'built-in',
  handler: async () => {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      showToast('No active session');
      return;
    }
    showToast('Compacting...', { type: 'info', autoHideMs: 5000 });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/compact`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(`Compacted: ${data.tokensRemoved} tokens, ${data.messagesRemoved} messages removed`, { type: 'success', autoHideMs: 5000 });
      } else {
        showToast(data.error || 'Compaction failed');
      }
    } catch {
      showToast('Compaction failed');
    }
  }
});
