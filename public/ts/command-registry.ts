import { newSessionClick } from './router.js';
import { getActiveSessionId, getAvailableModels, notifyMessageSent } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
import { setActiveContextBudget, setActiveReasoningEffort } from './context-footer.js';
import { archiveSession, renameSession } from './session-panel.js';
import type { PopupItem } from './input-popup.js';
import { parseAgentDispatchInput } from './agent-command.js';

export interface Command {
  name: string;
  description: string;
  source: 'built-in' | 'template' | 'extension';
  handler: (args: string) => void | Promise<void>;
  picker?: () => PopupItem[] | Promise<PopupItem[]>;
}

export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'session-new', description: 'New chat' },
  { name: 'agent', description: 'Dispatch prompt with an SDK custom agent' },
  { name: 'session-rename', description: 'Rename current session' },
  { name: 'session-cwd', description: 'Change session working directory' },
  { name: 'session-folder', description: 'Move session to a folder (or "/" for root)' },
  { name: 'session-archive', description: 'Archive current session' },
  { name: 'session-model', description: 'Change session model' },
  { name: 'restart', description: 'Restart the Caco server' },
  { name: 'session-export', description: 'Export current session as .tar.gz' },
  { name: 'session-fork', description: 'Fork session into a new side conversation (inherits history)' },
  { name: 'session-compact', description: 'Force context compaction (optionally add text to focus the summary)' },
  { name: 'session-context-window', description: 'Cap session context window (compact earlier to cut cost)' },
  { name: 'session-effort', description: 'Set reasoning effort for models that support it' },
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

registerBuiltin('agent', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }

  const parsed = parseAgentDispatchInput(arg);
  if (!parsed) {
    showToast('Usage: /agent <agent-name> <prompt>');
    return;
  }

  const originalCommand = `/agent ${arg.trim()}`;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agent-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Agent dispatch failed' }));
      restoreActiveInput(originalCommand);
      showToast(data.error || 'Agent dispatch failed');
    } else {
      chatView.savePrompt(originalCommand, sessionId);
      notifyMessageSent(sessionId);
    }
  } catch (error) {
    restoreActiveInput(originalCommand);
    showToast(`Agent dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}, async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return []; }
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to list agents' }));
      showToast(data.error || 'Failed to list agents');
      return [];
    }
    const data = await res.json() as {
      agents?: Array<{ name: string; displayName?: string; description?: string; model?: string }>;
    };
    const agents = data.agents ?? [];
    if (agents.length === 0) {
      showToast('No SDK agents available');
      return [];
    }
    return agents.map(agent => ({
      id: agent.name,
      label: agent.displayName ? `${agent.displayName} (${agent.name})` : agent.name,
      description: [agent.description, agent.model].filter(Boolean).join(' · '),
      value: `${agent.name} `,
    }));
  } catch (error) {
    showToast(`Failed to list agents: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
});

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
      const data = await res.json().catch(() => ({}));
      const effectiveCwd = typeof data.cwd === 'string' ? data.cwd : trimmed;
      chatView.applyCwdChange(sessionId, effectiveCwd, !!data.hasGit, data.gitBranch ?? null);
      showToast(`CWD → ${effectiveCwd}`, { type: 'success', autoHideMs: 3000 });
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
    const description = m.priceCategory ?? (m.cost === 0 ? 'free' : '');
    return { id: m.id, label: m.name, description };
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

registerBuiltin('session-compact', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const focus = arg.trim();
  showToast(focus ? 'Compacting (focused)...' : 'Compacting...', { type: 'info', autoHideMs: 5000 });
  try {
    const res = await fetch(`/api/sessions/${sessionId}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(focus ? { customInstructions: focus } : {}),
    });
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

registerBuiltin('session-context-window', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = arg.trim().toLowerCase();
  let tokens: number | null;
  if (trimmed === '' || trimmed === 'default' || trimmed === 'reset' || trimmed === 'full' || trimmed === 'clear') {
    tokens = null;
  } else {
    tokens = parseTokenCount(trimmed);
    if (tokens === null) { showToast(`Invalid token count: ${arg.trim()}`); return; }
  }
  showToast(tokens === null ? 'Clearing context cap...' : 'Capping context — reconnecting...', { type: 'info', autoHideMs: 4000 });
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextBudgetTokens: tokens }),
    });
    if (res.ok) {
      setActiveContextBudget(tokens);
      const msg = tokens === null
        ? 'Context cap cleared (SDK default ~80%)'
        : `Context capped at ${formatTokenCount(tokens)} — history replays once`;
      showToast(msg, { type: 'success', autoHideMs: 4000 });
    } else {
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      showToast(data.error || 'Failed to set context window');
    }
  } catch (e) {
    showToast(`Failed to set context window: ${e instanceof Error ? e.message : String(e)}`);
  }
}, async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) return [{ id: 'default', label: 'No active session', description: '' }];
  let model: string | null = null;
  let current: number | null = null;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    if (res.ok) {
      const data = await res.json();
      model = data.model ?? null;
      current = data.contextBudgetTokens ?? null;
    }
  } catch { /* fall through to defaults */ }
  const w = model ? (getAvailableModels().find(m => m.id === model)?.contextWindow ?? 0) : 0;
  const items: PopupItem[] = [];
  if (w > 0) {
    const seen = new Set<number>();
    for (const pct of [0.2, 0.4, 0.6, 0.8]) {
      const raw = pct * w;
      const snapped = Math.round(raw / 100_000) * 100_000;
      const effective = snapped > 0 ? snapped : Math.round(raw);
      if (seen.has(effective)) continue;
      seen.add(effective);
      const pctLabel = Math.round((effective / w) * 100);
      const desc = `${pctLabel}%${current === effective ? ' · current' : ''}`;
      items.push({ id: String(effective), label: formatTokenCount(effective), description: desc, danger: effective < 100_000 });
    }
    items.sort((a, b) => Number(a.id) - Number(b.id));
  }
  items.push({ id: 'default', label: 'SDK default (~80%)', description: current === null ? 'current' : 'clear cap' });
  return items;
});

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh' };

registerBuiltin('session-effort', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const effortId = arg.trim();
  if (!effortId) {
    showToast('Use the picker: /session-effort', { type: 'info', autoHideMs: 2000 });
    return;
  }
  await applyEffort(sessionId, effortId);
}, async () => {
  const sessionId = getActiveSessionId();
  if (!sessionId) return [{ id: 'none', label: 'No active session', description: '' }];
  let currentEffort: string | null = null;
  let model: string | null = null;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    if (res.ok) {
      const data = await res.json();
      currentEffort = data.reasoningEffort ?? null;
      model = data.model ?? null;
    }
  } catch { /* fall through */ }
  const modelInfo = model ? getAvailableModels().find(m => m.id === model) : undefined;
  const supported = modelInfo?.supportedReasoningEfforts ?? [];
  if (!modelInfo?.supportsReasoningEffort || supported.length === 0) {
    return [{ id: 'none', label: 'Model does not support reasoning effort', description: '' }];
  }
  const defaultEffort = modelInfo?.defaultReasoningEffort ?? null;
  const items: PopupItem[] = [
    { id: 'default', label: 'Default', description: defaultEffort ? `Model default (${EFFORT_LABELS[defaultEffort] ?? defaultEffort})${currentEffort === null || currentEffort === defaultEffort ? ' · current' : ''}` : 'clear effort' },
  ];
  for (const e of supported) {
    const label = EFFORT_LABELS[e] ?? e;
    items.push({ id: e, label, description: currentEffort === e ? 'current' : '' });
  }
  return items;
});

async function applyEffort(sessionId: string, effortId: string): Promise<void> {
  const effort = effortId === 'default' ? null : effortId;
  if (effortId === 'none') return;
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: effort }),
    });
    if (res.ok) {
      setActiveReasoningEffort(effort);
      const label = effort ? (EFFORT_LABELS[effort] ?? effort) : 'Default';
      showToast(`Reasoning effort set to ${label}`, { type: 'success', autoHideMs: 3000 });
    } else {
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      showToast(data.error || 'Failed to set reasoning effort');
    }
  } catch (e) {
    showToast(`Failed to set reasoning effort: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseTokenCount(s: string): number | null {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1_000;
  else if (unit === 'm') n *= 1_000_000;
  return Math.round(n);
}

export function restoreCommandInput(form: { textarea: HTMLTextAreaElement } | null, message: string): void {
  if (!form) return;
  form.textarea.value = message;
  form.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  form.textarea.focus();
}

function restoreActiveInput(message: string): void {
  const form = chatView.getActiveForm();
  restoreCommandInput(form, message);
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}
