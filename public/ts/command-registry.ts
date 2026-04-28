import { newSessionClick } from './router.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
import { archiveSession, renameSession } from './session-panel.js';
import type { PopupItem } from './input-popup.js';

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
  name: 'session-new',
  description: 'New chat',
  source: 'built-in',
  handler: () => newSessionClick()
});

registerCommand({
  name: 'session-rename',
  description: 'Rename current session',
  source: 'built-in',
  handler: async (newName) => {
    const sessionId = getActiveSessionId();
    if (!sessionId) { showToast('No active session'); return; }
    const trimmed = newName.trim();
    if (!trimmed) { showToast('Usage: /session-rename <new name>'); return; }
    await renameSession(sessionId, trimmed);
  }
});

registerCommand({
  name: 'session-cwd',
  description: 'Change session working directory',
  source: 'built-in',
  handler: async (newCwd) => {
    const sessionId = getActiveSessionId();
    if (!sessionId) { showToast('No active session'); return; }
    const trimmed = newCwd.trim();
    if (!trimmed) { showToast('Usage: /session-cwd <path>'); return; }
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: trimmed })
      });
      if (res.ok) {
        chatView.updateStatus(trimmed);
        showToast(`CWD → ${trimmed}`, { type: 'success', autoHideMs: 3000 });
      } else {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        showToast(data.error || 'Failed to change CWD');
      }
    } catch {
      showToast('Failed to change CWD');
    }
  }
});

registerCommand({
  name: 'session-folder',
  description: 'Move session to a folder (or "/" for root)',
  source: 'built-in',
  handler: async (arg) => {
    const sessionId = getActiveSessionId();
    if (!sessionId) { showToast('No active session'); return; }
    const trimmed = arg.trim();
    if (!trimmed) { showToast('Usage: /session-folder <name> or / for root'); return; }
    if (trimmed !== '/' && trimmed.toLowerCase() !== 'root' && trimmed.includes('/')) {
      showToast('Nested folders not supported yet');
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: trimmed })
      });
      if (res.ok) {
        const dest = (trimmed === '/' || trimmed.toLowerCase() === 'root') ? 'root' : `/${trimmed}`;
        showToast(`Session moved to ${dest}`, { type: 'success', autoHideMs: 3000 });
      } else {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        showToast(data.error || 'Failed to move session');
      }
    } catch {
      showToast('Failed to move session');
    }
  }
});

registerCommand({
  name: 'session-archive',
  description: 'Archive current session',
  source: 'built-in',
  handler: async () => {
    const sessionId = getActiveSessionId();
    if (!sessionId) { showToast('No active session'); return; }
    const res = await fetch(`/api/sessions/${sessionId}/state`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    const name = data?.name || data?.summary || undefined;
    await archiveSession(sessionId, name);
  }
});

registerCommand({
  name: 'session-model',
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
  name: 'session-export',
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
  name: 'session-compact',
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
