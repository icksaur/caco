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

export interface AgentDispatchRequest {
  agentName: string;
  prompt: string;
}

export function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function isUsableAgent(agent: SdkAgentInfo): boolean {
  return agent.userInvocable !== false && !hasWhitespace(agent.name);
}

export function visibleAgents(agents: SdkAgentInfo[]): SdkAgentInfo[] {
  return agents.filter(isUsableAgent);
}

export function parseAgentDispatchInput(input: string): AgentDispatchRequest | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  const [, agentName, prompt] = match;
  if (!agentName || !prompt.trim() || hasWhitespace(agentName)) return null;
  return { agentName, prompt: prompt.trim() };
}

export type AgentValidationResult =
  | { ok: true; agent: SdkAgentInfo }
  | { ok: false; status: 400 | 404; error: string };

export function validateAgentForUserDispatch(agents: SdkAgentInfo[], agentName: string): AgentValidationResult {
  if (!agentName.trim()) return { ok: false, status: 400, error: 'agentName is required' };
  if (hasWhitespace(agentName)) return { ok: false, status: 400, error: 'Agent names with whitespace are not supported' };

  const agent = agents.find(candidate => candidate.name === agentName);
  if (!agent) return { ok: false, status: 404, error: `Agent not found: ${agentName}` };
  if (agent.userInvocable === false) return { ok: false, status: 404, error: `Agent not invocable: ${agentName}` };
  if (hasWhitespace(agent.name)) return { ok: false, status: 400, error: 'Agent names with whitespace are not supported' };
  return { ok: true, agent };
}
