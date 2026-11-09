/**
 * Comms guard (docs/spec-comms-guard.md): tools that send communication a
 * person will read (mail, Teams, PR and work item comments, ICM posts) are
 * denied in turns the user did not start. Enforced through the SDK's
 * `onPreToolUse` hook; the tools stay in the session so tool lists and the
 * prompt cache never churn.
 */
import type { SessionIdRef } from './types.js';

export type CommsGuardMode = 'unattended' | 'always' | 'off';

export const COMMS_GUARD_MODES: readonly CommsGuardMode[] = ['unattended', 'always', 'off'];

/**
 * Tool-name globs (`*` wildcard, case-insensitive), matched against the full
 * model-facing name and every suffix after a server separator (`-`, `/`, `.`,
 * `:`, `__`), so `ReplyToMessage` matches `mail-ReplyToMessage`. A `#a,b`
 * suffix restricts the pattern to calls whose `action` argument is one of the
 * listed values (multi-action ADO tools).
 */
export const DEFAULT_COMMS_GUARD_PATTERNS: readonly string[] = [
  // Mail: sending, replying, forwarding. Drafts (CreateDraftMessage, UpdateDraft) stay allowed.
  'SendDraftMessage',
  'SendEmail*',
  'Reply*ToMessage',
  'Reply*WithFullThread',
  'ForwardMessage*',
  // Teams. SendMessageToSelf (the user's own notification channel) stays allowed.
  'SendMessageToChat',
  'SendMessageToChannel',
  'SendMessageToUser',
  'ReplyToChannelMessage',
  'UpdateChatMessage',
  'SendFileTo*',
  'AddChatMember',
  'AddChannelMember',
  'CreateChat',
  // Azure DevOps: PR threads and replies, work item comments, reviewers.
  // Thread status updates (resolve) stay allowed.
  'repo_create_pull_request_thread',
  'repo_reply_to_comment',
  'repo_pull_request_thread_write#create,reply,update',
  'wit_add_work_item_comment',
  'wit_update_work_item_comment',
  'wit_work_item_comment_write#add,update',
  'repo_update_pull_request_reviewers',
  'repo_pull_request_write#update_reviewers',
  // IcM: discussion and insight posts, incident state changes, paging.
  'post_discussion_entry',
  'post_incident_insight',
  'acknowledge_incident',
  'mitigate_incident',
  'resolve_incident',
  'reactivate_incident',
  'transfer_incident',
  'update_incident',
  'update_incident_severity',
  'request_assistance',
];

const SEPARATOR = /(?:__|[-/.:])/g;

/** The full name plus every suffix that follows a server separator. */
export function nameCandidates(toolName: string): string[] {
  const out = [toolName];
  for (const m of toolName.matchAll(SEPARATOR)) {
    const rest = toolName.slice((m.index ?? 0) + m[0].length);
    if (rest) out.push(rest);
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

function actionOf(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'action' in args) {
    const a = (args as { action?: unknown }).action;
    if (typeof a === 'string') return a.toLowerCase();
  }
  return undefined;
}

/** Whether a call matches any guarded pattern. An action-scoped pattern also
 *  matches a call with no string `action` (fail closed). */
export function isGuardedCall(toolName: string, args: unknown, patterns: readonly string[]): boolean {
  const names = nameCandidates(toolName);
  const action = actionOf(args);
  for (const p of patterns) {
    const hash = p.indexOf('#');
    const glob = (hash < 0 ? p : p.slice(0, hash)).trim();
    if (!glob) continue;
    const re = globToRegExp(glob);
    if (!names.some(n => re.test(n))) continue;
    if (hash < 0) return true;
    const actions = p.slice(hash + 1).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (action === undefined || actions.includes(action)) return true;
  }
  return false;
}

export interface CommsGuardConfig {
  mode: CommsGuardMode;
  patterns: readonly string[];
}

export type CommsGuardVerdict = { deny: false } | { deny: true; reason: string };

/** Pure decision for one tool call. */
export function decideCommsGuard(toolName: string, args: unknown, humanRooted: boolean, cfg: CommsGuardConfig): CommsGuardVerdict {
  if (cfg.mode === 'off') return { deny: false };
  if (cfg.mode === 'unattended' && humanRooted) return { deny: false };
  if (!isGuardedCall(toolName, args, cfg.patterns)) return { deny: false };
  const why = cfg.mode === 'always'
    ? 'Caco is set to block it in every turn (commsGuard: always)'
    : 'this turn was not started by the user';
  return {
    deny: true,
    reason: `Blocked: ${toolName} sends communication a person will read, and ${why}. ` +
      'Do not retry or work around this with another tool. Write a draft in your reply and offer it as a caco-actions option so the user can send it.',
  };
}

/** Normalize a stored preference into a config (unknown mode -> 'unattended';
 *  a non-array or empty pattern list -> the defaults). */
export function resolveCommsGuardConfig(prefs: { commsGuard?: unknown; commsGuardPatterns?: unknown } | null | undefined): CommsGuardConfig {
  const mode = COMMS_GUARD_MODES.includes(prefs?.commsGuard as CommsGuardMode) ? prefs!.commsGuard as CommsGuardMode : 'unattended';
  const raw = prefs?.commsGuardPatterns;
  const patterns = Array.isArray(raw) && raw.length && raw.every(p => typeof p === 'string')
    ? raw as string[]
    : DEFAULT_COMMS_GUARD_PATTERNS;
  return { mode, patterns };
}

// --- Runtime: turn roots and the hook ---------------------------------------

/** Per-session root of the in-flight dispatch. Absent = no dispatch = unattended. */
const turnRoots = new Map<string, boolean>();

export function setTurnRoot(sessionId: string, humanRooted: boolean): void {
  turnRoots.set(sessionId, humanRooted);
}

export function clearTurnRoot(sessionId: string): void {
  turnRoots.delete(sessionId);
}

export function isTurnHumanRooted(sessionId: string): boolean {
  return turnRoots.get(sessionId) === true;
}

let configProvider: () => CommsGuardConfig = () => resolveCommsGuardConfig(null);

export function setCommsGuardConfigProvider(fn: () => CommsGuardConfig): void {
  configProvider = fn;
}

interface PreToolUseInput { toolName: string; toolArgs?: unknown }
interface PreToolUseOutput { permissionDecision: 'deny'; permissionDecisionReason: string }

/**
 * onPreToolUse handler. Keyed on the Caco session (`sessionRef`), not the
 * hook's sessionId, so SDK sub-agent tool calls inherit the parent turn's root.
 * Logs the session and tool name only, never arguments.
 */
export function createCommsGuardHook(sessionRef: SessionIdRef) {
  return (input: PreToolUseInput): PreToolUseOutput | void => {
    const sessionId = sessionRef.id;
    const humanRooted = sessionId ? isTurnHumanRooted(sessionId) : false;
    const verdict = decideCommsGuard(input.toolName, input.toolArgs, humanRooted, configProvider());
    if (!verdict.deny) return;
    console.warn(`[COMMS-GUARD] Denied ${input.toolName} in ${sessionId ? sessionId.slice(0, 8) : 'unknown'}`);
    return { permissionDecision: 'deny', permissionDecisionReason: verdict.reason };
  };
}
