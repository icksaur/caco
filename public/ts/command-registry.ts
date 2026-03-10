import { newSessionClick, sessionClick } from './router.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
import { sortSessions } from './ui-utils.js';
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

registerCommand({
  name: 'sessions',
  description: 'Switch session',
  source: 'built-in',
  picker: async () => {
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
  },
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
      await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId })
      });
      chatView.updateStatus(chatView.getCwd(), modelId);
    } else {
      // New chat: just update the model selector
      selectModel(modelId);
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
      showToast(data.message);
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
    showToast('Exporting session...');
  }
});

registerCommand({
  name: 'sessiontransfer',
  description: 'Transfer session to another Caco instance',
  source: 'built-in',
  handler: async (args) => {
    const url = args.trim().replace(/\/+$/, '');
    if (!url) { showToast('Usage: /sessiontransfer https://host.example.com'); return; }
    if (!url.startsWith('https://')) { showToast('URL must be HTTPS'); return; }
    const sessionId = getActiveSessionId();
    if (!sessionId) { showToast('No active session'); return; }

    try {
      const res = await fetch(url + '/api/sessions', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const exists = Object.values(data.grouped).flat().some((s: any) => s.sessionId === sessionId);
      if (exists) { showToast('Session already exists on remote'); return; }
    } catch {
      showToast('Cannot reach remote Caco'); return;
    }

    showToast('Compacting...');
    await fetch('/api/sessions/' + sessionId + '/compact', { method: 'POST' }).catch(() => {});

    showToast('Exporting...');
    let blob: Blob;
    try {
      const res = await fetch('/api/sessions/' + sessionId + '/export', { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blob = await res.blob();
    } catch { showToast('Failed to export session'); return; }

    showToast('Uploading...');
    try {
      const res = await fetch(url + '/api/sessions/import', {
        method: 'POST', body: blob,
        headers: { 'Content-Type': 'application/gzip' },
        signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + res.status); }
    } catch (e) { showToast('Import failed: ' + (e instanceof Error ? e.message : e)); return; }

    try {
      await fetch('/api/sessions/' + sessionId, { method: 'DELETE' });
      showToast('Session transferred!');
      chatView.showNewChat();
    } catch {
      showToast('Transferred but failed to delete local copy');
    }
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
    showToast('Compacting...');
    try {
      const res = await fetch(`/api/sessions/${sessionId}/compact`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(`Compacted: ${data.tokensRemoved} tokens, ${data.messagesRemoved} messages removed`);
      } else {
        showToast(data.error || 'Compaction failed');
      }
    } catch {
      showToast('Compaction failed');
    }
  }
});
