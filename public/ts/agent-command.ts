export interface AgentDispatchInput {
  agentName: string;
  prompt: string;
}

export function parseAgentDispatchInput(input: string): AgentDispatchInput | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  const [, agentName, prompt] = match;
  if (!agentName || /\s/.test(agentName) || !prompt.trim()) return null;
  return { agentName, prompt: prompt.trim() };
}
