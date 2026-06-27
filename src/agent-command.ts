export interface SdkAgentInfo {
  name: string;
  id: string;
  displayName: string;
  description: string;
  path?: string;
  source?: unknown;
  userInvocable?: boolean;
  tools?: string[];
  model?: string;
  mcpServers?: Record<string, unknown>;
  skills?: string[];
}

export interface SdkCommandInfo {
  name: string;
  description?: string;
  kind?: string;
  input?: { hint?: string; required?: boolean };
  allowDuringAgentExecution?: boolean;
  userInvocable?: boolean;
}

export interface SkillCommand {
  name: string;
  description: string;
  hint?: string;
}

/** Keep only user-invocable skill commands from a raw `commands.list` result. */
export function filterSkillCommands(commands: SdkCommandInfo[]): SkillCommand[] {
  return commands
    .filter(c => c.kind === 'skill' && c.userInvocable !== false && typeof c.name === 'string' && c.name.length > 0)
    .map(c => ({ name: c.name, description: c.description ?? '', hint: c.input?.hint }));
}

/** SDK slash-command invocation result. A skill returns `kind:'agent-prompt'`; other
 *  kinds (`text`, `completed`, `select-subcommand`) carry their own optional fields. */
export interface SdkCommandInvokeResult {
  kind: string;
  prompt?: string;
  displayPrompt?: string;
  text?: string;
  message?: string;
  [k: string]: unknown;
}

/** A usable slug is the whitespace-free `id` the SDK derives from the agent filename.
 *  It is always a safe, parser-friendly invocation token. */
export function isUsableSlug(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.trim() === id && !/\s/.test(id);
}

export function isUsableAgent(agent: SdkAgentInfo): boolean {
  return agent.userInvocable !== false && isUsableSlug(agent.id);
}

export function visibleAgents(agents: SdkAgentInfo[]): SdkAgentInfo[] {
  return agents.filter(isUsableAgent);
}

export type AgentResolution =
  | { ok: true; agentId: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Resolve a raw `/agent` payload to an agent slug. `/agent <name>` **selects** an agent
 * (loads its persona into the session); it carries **no prompt**. A frontmatter `name`
 * may contain spaces, so a trailing prompt cannot be disambiguated from the name — hence
 * the entire payload is the identifier. This mirrors the Copilot CLI's select-only
 * `/agent <name>` (which emits "Selected custom agent: X" and does not respond). After
 * selection the agent stays active, so the user's *next* normal message runs as it.
 *
 * Exact, case-sensitive match of the full identifier against the slug `id`, frontmatter
 * `name`, or `displayName` (slug `id` wins on collision). No match → 404. Only a known
 * agent id is ever forwarded to `agent.select`.
 */
export function resolveAgentSelection(agents: SdkAgentInfo[], input: string): AgentResolution {
  const id = input.trim();
  if (!id) return { ok: false, status: 400, error: 'Usage: /agent <agent-name>' };

  const bySlug = agents.find(agent => agent.id === id);
  if (bySlug) return { ok: true, agentId: bySlug.id };

  const byName = agents.find(agent => agent.name === id || agent.displayName === id);
  if (byName) return { ok: true, agentId: byName.id };

  return { ok: false, status: 404, error: `Agent not found: ${id}` };
}
