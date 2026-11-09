import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_COMMS_GUARD_PATTERNS,
  createCommsGuardHook,
  decideCommsGuard,
  isGuardedCall,
  nameCandidates,
  resolveCommsGuardConfig,
  setCommsGuardConfigProvider,
  setTurnRoot,
  clearTurnRoot,
  type CommsGuardConfig,
} from '../../src/comms-guard.js';

const D = DEFAULT_COMMS_GUARD_PATTERNS;
const cfg = (mode: CommsGuardConfig['mode'] = 'unattended'): CommsGuardConfig => ({ mode, patterns: D });

describe('comms guard patterns (spec-comms-guard)', () => {
  it('splits server prefixes in every common form', () => {
    expect(nameCandidates('mail-ReplyToMessage')).toEqual(['mail-ReplyToMessage', 'ReplyToMessage']);
    expect(nameCandidates('mail__ReplyToMessage')).toContain('ReplyToMessage');
    expect(nameCandidates('mail/ReplyToMessage')).toContain('ReplyToMessage');
    expect(nameCandidates('github-mcp-server-add_issue_comment')).toContain('add_issue_comment');
    expect(nameCandidates('ADO-repo_reply_to_comment')).toEqual(['ADO-repo_reply_to_comment', 'repo_reply_to_comment']);
  });

  it.each([
    'mail-SendDraftMessage', 'mail-SendEmailWithAttachments', 'mail-ReplyToMessage', 'mail-ReplyAllToMessage',
    'mail-ReplyWithFullThread', 'mail-ReplyAllWithFullThread', 'mail-ForwardMessage', 'mail-ForwardMessageWithFullThread',
    'teams-SendMessageToChat', 'teams-SendMessageToChannel', 'teams-SendMessageToUser', 'teams-ReplyToChannelMessage',
    'teams-UpdateChatMessage', 'teams-SendFileToChat', 'teams-SendFileToChannel', 'teams-SendFileToUser',
    'teams-AddChatMember', 'teams-AddChannelMember', 'teams-CreateChat',
    'ADO-repo_create_pull_request_thread', 'ADO-repo_reply_to_comment', 'ADO-wit_add_work_item_comment',
    'ADO-wit_update_work_item_comment', 'ADO-repo_update_pull_request_reviewers',
    'icm-mcp-post_discussion_entry', 'icm-mcp-post_incident_insight', 'icm-mcp-acknowledge_incident',
    'icm-mcp-mitigate_incident', 'icm-mcp-resolve_incident', 'icm-mcp-reactivate_incident', 'icm-mcp-transfer_incident',
    'icm-mcp-update_incident', 'icm-mcp-update_incident_severity', 'icm-mcp-request_assistance',
    'outlook/ReplyToMessage', 'TEAMS__sendmessagetochat',
  ])('guards %s', (name) => {
    expect(isGuardedCall(name, {}, D)).toBe(true);
  });

  it.each([
    'mail-CreateDraftMessage', 'mail-UpdateDraft', 'mail-AddDraftAttachments', 'mail-SearchMessages', 'mail-GetMessage',
    'teams-SendMessageToSelf', 'teams-ListChatMessages', 'teams-GetChat',
    'ADO-repo_update_pull_request_thread', 'ADO-repo_list_pull_request_threads', 'ADO-wit_list_work_item_comments',
    'ADO-repo_create_pull_request', 'ADO-wit_update_work_item',
    'icm-mcp-get_incident_details_by_id', 'icm-mcp-get_incident_discussion_entries', 'send_agent_message', 'caco_wake',
  ])('allows %s', (name) => {
    expect(isGuardedCall(name, {}, D)).toBe(false);
  });

  it('scopes multi-action ADO tools by action; thread status updates stay allowed', () => {
    const thread = 'ADO-repo_pull_request_thread_write';
    expect(isGuardedCall(thread, { action: 'create' }, D)).toBe(true);
    expect(isGuardedCall(thread, { action: 'reply' }, D)).toBe(true);
    expect(isGuardedCall(thread, { action: 'update' }, D)).toBe(true);
    expect(isGuardedCall(thread, { action: 'update_status' }, D)).toBe(false);
    expect(isGuardedCall('ADO-wit_work_item_comment_write', { action: 'add' }, D)).toBe(true);
    expect(isGuardedCall('ADO-repo_pull_request_write', { action: 'update_reviewers' }, D)).toBe(true);
    expect(isGuardedCall('ADO-repo_pull_request_write', { action: 'create' }, D)).toBe(false);
    expect(isGuardedCall('ADO-repo_pull_request_write', { action: 'vote' }, D)).toBe(false);
  });

  it('an action-scoped pattern fails closed when the action is missing', () => {
    expect(isGuardedCall('ADO-repo_pull_request_thread_write', {}, D)).toBe(true);
    expect(isGuardedCall('ADO-repo_pull_request_thread_write', undefined, D)).toBe(true);
  });

  it.each(['workiq-do_action', 'workiq-create_entity', 'workiq-update_entity', 'workiq-delete_entity', 'computer-use-click', 'computer-use-type_text'])(
    'guards the general-purpose channel %s', (name) => {
      expect(isGuardedCall(name, {}, D)).toBe(true);
    });

  it.each(['workiq-ask', 'workiq-fetch', 'workiq-retrieve'])('leaves workiq reads allowed: %s', (name) => {
    expect(isGuardedCall(name, {}, D)).toBe(false);
  });

  it.each([
    ['ADO-wit_update_work_item', { id: 1, updates: [{ path: '/fields/System.History', value: 'hi' }] }],
    ['ADO-wit_update_work_items_batch', { updates: [{ id: 1, path: '/fields/system.history', value: 'hi' }] }],
    ['ADO-wit_work_item_write', { action: 'update', fields: [{ name: 'System.History', value: 'hi' }] }],
    ['ADO-wit_create_work_item', { fields: [{ name: 'System.History', value: 'hi' }] }],
    ['ADO-wit_add_child_work_items', { items: [{ history: 'x', fields: { 'System.History': 'hi' } }] }],
  ])('guards %s when it writes System.History', (name, args) => {
    expect(isGuardedCall(name, args, D)).toBe(true);
  });

  it('allows work item writes that do not touch System.History, even with custom patterns', () => {
    expect(isGuardedCall('ADO-wit_update_work_item', { id: 1, updates: [{ path: '/fields/System.State', value: 'Active' }] }, D)).toBe(false);
    expect(isGuardedCall('ADO-wit_work_item_write', { action: 'update', fields: [{ name: 'System.Title', value: 'x' }] }, D)).toBe(false);
    expect(isGuardedCall('ADO-wit_update_work_item', { updates: [{ path: '/fields/System.History' }] }, ['Nothing'])).toBe(true);
  });
});

describe('comms guard decision', () => {
  it('unattended (default): human-rooted allowed, anything else denied with draft guidance', () => {
    expect(decideCommsGuard('mail-ReplyToMessage', {}, true, cfg())).toEqual({ deny: false });
    const v = decideCommsGuard('mail-ReplyToMessage', {}, false, cfg());
    expect(v.deny).toBe(true);
    if (v.deny) {
      expect(v.reason).toContain('Blocked: mail-ReplyToMessage');
      expect(v.reason).toContain('not started by the user');
      expect(v.reason).toContain('caco-actions');
    }
  });

  it('always denies a human turn; off allows everything', () => {
    expect(decideCommsGuard('teams-SendMessageToChat', {}, true, cfg('always')).deny).toBe(true);
    expect(decideCommsGuard('teams-SendMessageToChat', {}, false, cfg('off')).deny).toBe(false);
  });

  it('unguarded tools are never denied, even unattended', () => {
    expect(decideCommsGuard('teams-SendMessageToSelf', {}, false, cfg('always')).deny).toBe(false);
    expect(decideCommsGuard('mail-CreateDraftMessage', {}, false, cfg()).deny).toBe(false);
  });

  it('resolves preferences: unknown mode -> unattended, custom patterns replace defaults, empty -> defaults', () => {
    expect(resolveCommsGuardConfig(undefined)).toEqual({ mode: 'unattended', patterns: D });
    expect(resolveCommsGuardConfig({ commsGuard: 'bogus' }).mode).toBe('unattended');
    expect(resolveCommsGuardConfig({ commsGuard: 'always' }).mode).toBe('always');
    expect(resolveCommsGuardConfig({ commsGuardPatterns: ['Foo*'] }).patterns).toEqual(['Foo*']);
    expect(resolveCommsGuardConfig({ commsGuardPatterns: [] }).patterns).toBe(D);
  });
});

describe('comms guard hook', () => {
  const ref = { id: 'sess-1234-abcd' };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCommsGuardConfigProvider(() => cfg());
  });
  afterEach(() => {
    clearTurnRoot(ref.id);
    warn.mockRestore();
  });

  it('denies an unattended turn and logs only the session and tool name', () => {
    setTurnRoot(ref.id, false);
    const out = createCommsGuardHook(ref)({ toolName: 'mail-SendEmailWithAttachments', toolArgs: { body: 'secret text' } });
    expect(out).toMatchObject({ permissionDecision: 'deny' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('mail-SendEmailWithAttachments');
    expect(line).toContain('sess-123');
    expect(line).not.toContain('secret');
  });

  it('allows a human-rooted turn', () => {
    setTurnRoot(ref.id, true);
    expect(createCommsGuardHook(ref)({ toolName: 'mail-SendEmailWithAttachments', toolArgs: {} })).toBeUndefined();
  });

  it('fails closed with no dispatch in flight', () => {
    expect(createCommsGuardHook(ref)({ toolName: 'teams-SendMessageToChat', toolArgs: {} })).toMatchObject({ permissionDecision: 'deny' });
  });

  it('follows the live preference', () => {
    setTurnRoot(ref.id, true);
    setCommsGuardConfigProvider(() => cfg('always'));
    expect(createCommsGuardHook(ref)({ toolName: 'teams-SendMessageToChat', toolArgs: {} })).toMatchObject({ permissionDecision: 'deny' });
    setTurnRoot(ref.id, false);
    setCommsGuardConfigProvider(() => cfg('off'));
    expect(createCommsGuardHook(ref)({ toolName: 'teams-SendMessageToChat', toolArgs: {} })).toBeUndefined();
  });
});
