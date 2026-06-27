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
  | { ok: true; agentId: string; prompt: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Resolve a raw `/agent` payload (`<token> <prompt…>`) against the active agent list.
 * The SDK accepts an agent's slug `id`, frontmatter `name`, or `displayName`, but Caco's
 * combined select+dispatch command must split the identifier from the prompt itself.
 *
 * Deterministic, exact, case-sensitive:
 *  1. If the first whitespace-delimited token is a known slug `id`, that agent wins;
 *     the remainder is the prompt. (The slug is whitespace-free, so this is the common,
 *     unambiguous path the picker produces.)
 *  2. Otherwise greedily match the LONGEST identifier (`name`/`displayName`) that equals
 *     the input or is a prefix ending on a whitespace boundary; the remainder is the
 *     prompt. (Boundary-anchored so `name "agent"` never matches input `agentic …`.)
 *  3. Otherwise no known agent matched → 404. Only a resolved, known agent id is ever
 *     forwarded to `agent.select`; free-form input is never selected raw.
 *
 * A resolved agent with an empty remaining prompt → 400 (Caco has no select-only mode).
 */
export function resolveAgentDispatch(agents: SdkAgentInfo[], input: string): AgentResolution {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, status: 400, error: 'Usage: /agent <agent> <prompt>' };

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const firstToken = match ? match[1] : trimmed;
  const rest = (match && match[2] ? match[2] : '').trim();

  const bySlug = agents.find(agent => agent.id === firstToken);
  if (bySlug) {
    if (!rest) return { ok: false, status: 400, error: 'prompt is required' };
    return { ok: true, agentId: bySlug.id, prompt: rest };
  }

  let best: { len: number; agentId: string; prompt: string } | null = null;
  for (const agent of agents) {
    for (const identifier of [agent.name, agent.displayName]) {
      if (!identifier) continue;
      if (trimmed === identifier || trimmed.startsWith(identifier + ' ')) {
        const prompt = trimmed.slice(identifier.length).trim();
        if (!best || identifier.length > best.len) best = { len: identifier.length, agentId: agent.id, prompt };
      }
    }
  }
  if (best) {
    if (!best.prompt) return { ok: false, status: 400, error: 'prompt is required' };
    return { ok: true, agentId: best.agentId, prompt: best.prompt };
  }

  return { ok: false, status: 404, error: `Agent not found: ${firstToken}` };
}
