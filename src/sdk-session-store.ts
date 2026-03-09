import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export const STATE_DIR = join(homedir(), '.copilot', 'session-state');

function sessionPath(sessionId: string, file: string): string {
  return join(homedir(), '.copilot', 'session-state', sessionId, file);
}

export interface SessionWorkspace {
  updatedAt?: string;
  summary?: string;
  cwd?: string;
}

export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readSessionWorkspace(sessionId: string): SessionWorkspace | null {
  try {
    const yamlPath = sessionPath(sessionId, 'workspace.yaml');
    if (!existsSync(yamlPath)) return null;
    const parsed = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;
    return {
      updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    };
  } catch {
    return null;
  }
}

export function readSessionEvents(sessionId: string): SessionEvent[] {
  try {
    const eventsPath = sessionPath(sessionId, 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    const content = readFileSync(eventsPath, 'utf-8');
    const events: SessionEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return events;
  } catch {
    return [];
  }
}

export function parseSessionModel(sessionId: string): string | null {
  const events = readSessionEvents(sessionId);
  let model: string | null = null;
  for (const event of events) {
    if (event.type === 'session.start' && event.data?.selectedModel) {
      model = String(event.data.selectedModel);
    } else if (event.type === 'session.model_change' && event.data?.model) {
      model = String(event.data.model);
    }
  }
  return model;
}

export function listSessionIds(): string[] {
  try {
    const dir = join(homedir(), '.copilot', 'session-state');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}
