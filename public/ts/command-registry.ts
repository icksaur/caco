import { newSessionClick } from './router.js';
import { showSessionManager } from './session-panel.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
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

function getTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('#chatForm textarea[name="message"]');
}

registerCommand({
  name: 'new',
  description: 'New chat',
  source: 'built-in',
  handler: () => newSessionClick()
});

registerCommand({
  name: 'sessions',
  description: 'Open session panel',
  source: 'built-in',
  handler: () => showSessionManager()
});

registerCommand({
  name: 'help',
  description: 'Show available commands',
  source: 'built-in',
  handler: () => {
    const textarea = getTextarea();
    if (!textarea) return;
    const lines = getCommands().map(c => `/${c.name} — ${c.description}`);
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input'));
  }
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
