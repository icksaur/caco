import { newSessionClick } from './router.js';
import { showSessionManager } from './session-panel.js';

export interface Command {
  name: string;
  description: string;
  source: 'built-in' | 'template';
  handler: (args: string) => void | Promise<void>;
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
