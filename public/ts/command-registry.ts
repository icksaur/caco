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

export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'session-new', description: 'New chat' },
  { name: 'session-rename', description: 'Rename current session' },
  { name: 'session-cwd', description: 'Change session working directory' },
  { name: 'session-folder', description: 'Move session to a folder (or "/" for root)' },
  { name: 'session-archive', description: 'Archive current session' },
  { name: 'session-model', description: 'Change session model' },
  { name: 'restart', description: 'Restart the Caco server' },
  { name: 'session-export', description: 'Export current session as .tar.gz' },
  { name: 'session-fork', description: 'Fork session into a new side conversation (inherits history)' },
  { name: 'session-compact', description: 'Force context compaction' },
];

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.name, cmd);
  return () => { commands.delete(cmd.name); };
}

function registerBuiltin(name: string, handler: Command['handler'], picker?: Command['picker']): void {
  const entry = BUILTIN_COMMANDS.find(c => c.name === name);
  if (!entry) throw new Error(`Built-in command "${name}" not in BUILTIN_COMMANDS registry`);
  registerCommand({ name, description: entry.description, source: 'built-in', handler, picker });
}

export function getCommands(): Command[] {
  return [...commands.values()];
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name);
}

registerBuiltin('session-new', () => newSessionClick());

registerBuiltin('session-rename', async (newName) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = newName.trim();
  if (!trimmed) { showToast('Usage: /session-rename <new name>'); return; }
  await renameSession(sessionId, trimmed);
});

registerBuiltin('session-cwd', async (newCwd) => {
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
});

registerBuiltin('session-folder', async (arg) => {
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
});

registerBuiltin('session-archive', async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const res = await fetch(`/api/sessions/${sessionId}/state`).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  const name = data?.name || data?.summary || undefined;
  await archiveSession(sessionId, name);
});

registerBuiltin('session-model', async (modelId) => {
  const sessionId = getActiveSessionId();
  if (sessionId) {
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
    selectModel(modelId);
    showToast(`Model changed to ${modelId}`, { type: 'success', autoHideMs: 3000 });
  }
}, () => {
  const models = getAvailableModels();
  return models.map(m => {
    const cost = m.cost === 0 ? 'free' : `${m.cost}x`;
    return { id: m.id, label: m.name, description: cost };
  });
});

registerBuiltin('restart', async () => {
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    const data = await res.json();
    showToast(data.message, { type: 'info', autoHideMs: 3000 });
  } catch {
    showToast('Failed to restart server');
  }
});

registerBuiltin('session-export', async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  showToast('Exporting session...', { type: 'info', autoHideMs: 3000 });
  try {
    // Use a hidden iframe rather than blob+anchor click. Blob anchor clicks
    // can interact with the Navigation API / session restore in ways that
    // cause the download to re-trigger on hard refresh.
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = `/api/sessions/${sessionId}/export`;
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 60_000);
  } catch (e) {
    showToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

registerBuiltin('session-fork', async (message) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = message.trim();
  showToast('Forking session...', { type: 'info', autoHideMs: 2000 });
  try {
    const res = await fetch(`/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trimmed ? { initialMessage: trimmed } : {}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      showToast(data.error || 'Fork failed');
      return;
    }
    const data = await res.json();
    showToast(`Forked → ${data.name}`, { type: 'success', autoHideMs: 3000 });
    await chatView.activateSession(data.sessionId);
  } catch (e) {
    showToast(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

registerBuiltin('session-compact', async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
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
});
