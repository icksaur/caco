import { newSessionClick } from './router.js';
import { getActiveSessionId, getAvailableModels, onSessionActivate, onActiveSessionChange } from './app-state.js';
import { chatView } from './chat-view-controller.js';
import { selectModel } from './model-selector.js';
import { showToast } from './toast.js';
import { setActiveContextBudget, setActiveReasoningEffort } from './context-footer.js';
import { archiveSession, stageSessionForArchive, renameSession } from './session-panel.js';
import type { PopupItem } from './input-popup.js';

export interface Command {
  name: string;
  description: string;
  source: 'built-in' | 'template' | 'extension' | 'skill';
  handler: (args: string) => void | Promise<void>;
  picker?: () => PopupItem[] | Promise<PopupItem[]>;
}

export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'caco.session-new', description: 'New chat' },
  { name: 'caco.agent', description: 'Select an SDK custom agent (applies to your next message)' },
  { name: 'caco.session-rename', description: 'Rename current session' },
  { name: 'caco.session-cwd', description: 'Change session working directory' },
  { name: 'caco.session-folder', description: 'Move session to a folder (or "/" for root)' },
  { name: 'caco.session-archive', description: 'Stage session for archival (or "now" to archive immediately)' },
  { name: 'caco.session-model', description: 'Change session model' },
  { name: 'caco.restart', description: 'Restart the Caco server' },
  { name: 'caco.session-export', description: 'Export current session as .tar.gz' },
  { name: 'caco.session-fork', description: 'Fork session into a new side conversation (inherits history)' },
  { name: 'caco.session-compact', description: 'Force context compaction (optionally add text to focus the summary)' },
  { name: 'caco.session-context-window', description: 'Cap session context window (compact earlier to cut cost)' },
  { name: 'caco.session-effort', description: 'Set reasoning effort for models that support it' },
  { name: 'caco.plugin-directory', description: 'Load Open Plugins directories into this session only (no argument shows current)' },
];

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.name, cmd);
  return () => {
    if (commands.get(cmd.name) === cmd) commands.delete(cmd.name);
  };
}

function registerBuiltin(name: string, handler: Command['handler'], picker?: Command['picker']): void {
  const entry = BUILTIN_COMMANDS.find(c => c.name === name);
  if (!entry) throw new Error(`Built-in command "${name}" not in BUILTIN_COMMANDS registry`);
  registerCommand({ name, description: entry.description, source: 'built-in', handler, picker });
}

export function getCommands(): Command[] {
  return [...commands.values()];
}

/** Resolve a typed command name. A direct registration always wins, so a skill/extension
 *  using a bare name (e.g. `restart`) is reached as typed — the bare namespace belongs to
 *  the SDK/skills. Otherwise a legacy bare name falls back to its `caco.`-prefixed
 *  built-in (`/restart` → `caco.restart`), preserving muscle memory while ceding the bare
 *  name on collision. */
export function findCommand(name: string): Command | undefined {
  const direct = commands.get(name);
  if (direct) return direct;
  const prefixed = commands.get(`caco.${name}`);
  if (prefixed && prefixed.source === 'built-in') return prefixed;
  return undefined;
}

registerBuiltin('caco.session-new', () => newSessionClick());

/** Select an SDK custom agent for the active session. `/agent <name>` SELECTS only — no
 *  prompt, no turn; the agent stays active for the user's next message (CLI semantics).
 *  The server resolves the identifier against the live agent list (slug `id`, frontmatter
 *  `name`, or `displayName`). On success: green toast + a "Selected agent" transcript
 *  line (the form already cleared the input). On failure: red toast + input restored. */
async function selectAgentCommand(sessionId: string, input: string, originalCommand: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agent-select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Agent selection failed' }));
      restoreActiveInput(originalCommand);
      showToast(data.error || 'Agent selection failed');
    } else {
      const data = await res.json().catch(() => ({} as { agentId?: string }));
      if (data.agentId) showToast(`Selected ${data.agentId}`, { type: 'success', autoHideMs: 2000 });
    }
  } catch (error) {
    restoreActiveInput(originalCommand);
    showToast(`Agent selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

registerBuiltin('caco.agent', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }

  const input = arg.trim();
  if (!input) {
    showToast('Usage: /agent <agent-name>');
    return;
  }

  await selectAgentCommand(sessionId, input, `/agent ${input}`);
}, async () => {
  const agents = await fetchSessionAgents();
  if (agents === null) return [];
  if (agents.length === 0) { showToast('No SDK agents available'); return []; }
  return agents.map(agent => ({
    id: agent.id,
    label: agent.displayName && agent.displayName !== agent.id ? `${agent.displayName} (${agent.id})` : agent.id,
    description: [agent.description, agent.model].filter(Boolean).join(' · '),
    value: agent.id,
  }));
});

registerBuiltin('caco.session-rename', async (newName) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = newName.trim();
  if (!trimmed) { showToast('Usage: /session-rename <new name>'); return; }
  await renameSession(sessionId, trimmed);
});

registerBuiltin('caco.session-cwd', async (newCwd) => {
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

registerBuiltin('caco.session-folder', async (arg) => {
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

registerBuiltin('caco.session-archive', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const mode = arg.trim().toLowerCase();

  // Immediate archival stays reachable: converting a destructive command into a
  // deferred one would otherwise strand the user who wants the session gone now.
  if (mode === 'now') {
    const res = await fetch(`/api/sessions/${sessionId}/state`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    await archiveSession(sessionId, data?.name || data?.summary || undefined);
    return;
  }
  // Anything unrecognized is refused rather than guessed at, so a typo cannot
  // silently pick the wrong branch of a destructive command.
  if (mode !== '') { showToast('Usage: /session-archive (stage) or /session-archive now'); return; }

  await stageSessionForArchive(sessionId);
});

registerBuiltin('caco.session-model', async (modelId) => {
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

registerBuiltin('caco.restart', async () => {
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    const data = await res.json();
    showToast(data.message, { type: 'info', autoHideMs: 3000 });
  } catch {
    showToast('Failed to restart server');
  }
});

registerBuiltin('caco.session-export', async () => {
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

registerBuiltin('caco.session-fork', async (message) => {
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

registerBuiltin('caco.session-compact', async (arg) => {
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

registerBuiltin('caco.session-context-window', async (arg) => {
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

/** Words that clear the list. A slash command cannot pass `[]`, so these are its idiom
 *  for the same operation (spec-plugin-directories "clearing contract"). */
const PLUGIN_CLEAR_WORDS = new Set(['clear', 'none', 'reset']);

registerBuiltin('caco.plugin-directory', async (arg) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = arg.trim();

  // Bare invocation SHOWS, it does not clear: this value is otherwise invisible, and a
  // stray Enter must not destroy a working plugin config. Clearing is always explicit.
  if (!trimmed) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/state`);
      const dirs: string[] = res.ok ? ((await res.json()).pluginDirectories ?? []) : [];
      showToast(dirs.length ? `Plugin directories: ${dirs.join('  ')}` : 'Plugin directories: none',
        { type: 'info', autoHideMs: 8000 });
    } catch (e) {
      showToast(`Could not read plugin directories: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const clearing = PLUGIN_CLEAR_WORDS.has(trimmed.toLowerCase());
  const dirs = clearing ? [] : trimmed.split(/\s+/).filter(Boolean);

  // The pending toast is only honest when a reconnect will actually happen; an inactive
  // session is persist-only. We don't know liveness here, so say "applying" neutrally and
  // let the response report whether a reconnect occurred.
  if (!clearing) showToast('Loading plugins — reconnecting if this session is open…', { type: 'info', autoHideMs: 4000 });

  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginDirectories: dirs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Failed to set plugin directories'); return; }

    const warn = Array.isArray(data.pluginWarnings) && data.pluginWarnings.length
      ? ` — ${data.pluginWarnings.join('; ')}` : '';
    if (!data.pluginDirectoriesChanged) {
      showToast(`Plugin directories unchanged${warn}`, { type: 'info', autoHideMs: 3000 });
    } else if (clearing) {
      showToast(`Plugin directories cleared${warn}`, { type: 'success', autoHideMs: 4000 });
    } else {
      const tail = data.pluginDirectoriesRecreated ? 'session reconnected' : 'applies on next open';
      showToast(`Plugin directories set (${dirs.length}) — ${tail}${warn}`, { type: 'success', autoHideMs: 6000 });
    }
  } catch (e) {
    showToast(`Failed to set plugin directories: ${e instanceof Error ? e.message : String(e)}`);
  }
});

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh' };
registerBuiltin('caco.session-effort', async (arg) => {
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

interface SessionAgent { id: string; name: string; displayName?: string; description?: string; model?: string }

/** Fetch the active session's discovered SDK custom agents (project + user dirs,
 *  filtered server-side to user-invocable). Returns null on error (after toasting),
 *  [] when none. */
async function fetchSessionAgents(): Promise<SessionAgent[] | null> {
  const sessionId = getActiveSessionId();
  if (!sessionId) return null;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to list agents' }));
      showToast(data.error || 'Failed to list agents');
      return null;
    }
    const data = await res.json() as { agents?: SessionAgent[] };
    return data.agents ?? [];
  } catch (error) {
    showToast(`Failed to list agents: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface SessionSkill { name: string; description?: string; hint?: string }

/** Fetch the active session's discovered SDK skill commands (project + user dirs).
 *  Returns null on error (after toasting), [] when none. */
async function fetchSessionSkills(): Promise<SessionSkill[] | null> {
  const sessionId = getActiveSessionId();
  if (!sessionId) return null;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/skills`);
    if (!res.ok) return null;
    const data = await res.json() as { skills?: SessionSkill[] };
    return data.skills ?? [];
  } catch {
    return null;
  }
}

/** Invoke an SDK skill command for the active session. The server resolves the skill,
 *  calls `commands.invoke`, and dispatches the resulting agent-prompt turn (the user
 *  sees the skill's `displayPrompt`). On failure restores input + red toast. */
async function invokeSkill(sessionId: string, name: string, input: string, originalCommand: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/skill-invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, input }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Skill invocation failed' }));
      restoreActiveInput(originalCommand);
      showToast(data.error || 'Skill invocation failed');
    }
  } catch (error) {
    restoreActiveInput(originalCommand);
    showToast(`Skill invocation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// LIFECYCLE: per-session skill slash commands. Discovered SDK skills (~/.copilot/skills
// or project .github/skills) are registered as native `/<name>` commands, matching the
// Copilot CLI where skills (unlike agents) ARE slash commands. The skill set is
// cwd-dependent, so the batch is pruned on any active-session pointer change
// (`onActiveSessionChange`: switch, new chat, teardown) and re-derived on activation
// (`onSessionActivate`). Skills never shadow a built-in/template/extension command.
const skillCommandDisposers: Array<() => void> = [];

function disposeSkillCommands(): void {
  for (const dispose of skillCommandDisposers.splice(0)) {
    try { dispose(); } catch { /* ignore */ }
  }
}

export async function loadSkillCommands(): Promise<void> {
  // Capture the activation we're loading for; discard a fetch that resolves after the
  // user switched away (switches are not serialized).
  const sessionId = getActiveSessionId();
  const skills = await fetchSessionSkills();
  if (!skills) return;
  if (getActiveSessionId() !== sessionId) return; // superseded by a newer activation
  disposeSkillCommands();
  for (const skill of skills) {
    const existing = commands.get(skill.name); // direct lookup: bare-name aliases must NOT shadow a skill
    if (existing && existing.source !== 'skill') continue; // built-ins/templates win
    const dispose = registerCommand({
      name: skill.name,
      description: skill.description || skill.hint || `Skill ${skill.name}`,
      source: 'skill',
      handler: async (arg) => {
        const activeId = getActiveSessionId();
        if (!activeId) { showToast('No active session'); return; }
        const input = arg.trim();
        await invokeSkill(activeId, skill.name, input, `/${skill.name}${input ? ` ${input}` : ''}`);
      },
    });
    skillCommandDisposers.push(dispose);
  }
}

// Prune on any pointer change (new chat, switch, teardown) so a prior session's skill
// commands never linger in the menu — including when the next session's skill fetch
// fails (loadSkillCommands early-returns before disposing in that case).
onActiveSessionChange(() => disposeSkillCommands());
onSessionActivate(() => { void loadSkillCommands(); });

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}
