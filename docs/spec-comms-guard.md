# spec-comms-guard

Agents never send communication that a person will read. Carl does
person-to-person communication himself; agents write drafts. Caco enforces
this for turns the user did not start.

## Goals

- Unattended turns (scheduler wakes and slug runs, delegated and herd workers,
  `send_agent_message`, system and applet messages) cannot send mail, Teams
  messages, PR or work item comments, or IcM posts, even under prompt injection
  from the email or PR text they read.
- The model learns what to do instead: write a draft and offer it as a
  `caco-actions` option.
- Tool lists never change, so the prompt cache and the defer system are
  untouched.
- Carl can widen the guard to every turn, turn it off, or replace the list.

Non-goals: a sandbox. A turn with shell access can still reach anything (see
Risks). The guard is defense in depth against direct tool calls and prompt
injection.

## Design

**Turn root.** `dispatchMessage` (`src/routes/session-messages.ts`) takes a
`humanRooted` option and records it per session in `src/comms-guard.ts`
(`setTurnRoot`) when the dispatch starts. `completeDispatch` clears it. Only
two callers pass `true`:

- `POST /api/sessions/:id/messages` with no `source` (Carl typed it);
- `POST /api/sessions/:id/skill-invoke` (Carl invoked a skill).

Every other dispatch is unattended: `scheduler`, `agent`, `system`, `applet`,
the fork notice, and anything with no recorded root (fail closed). The root is
decided by the dispatch, not by the session, so a herd child or delegate target
is unattended whichever session it runs in.

**Continuations.** `IdleAuthorityCtx.humanRooted` carries the root into
`runAutoContinue`, which passes it to the continuation's dispatch. A
continuation of a human turn stays human-rooted, a continuation of a wake
stays unattended, and chains pass it on, exactly like `needsObservation`
(spec-observation-verdict-completeness).

**Steering.** A steer (`mode:'immediate'`) joins the running turn and does not
change its root. A steer into a wake turn is still unattended. Carl can send a
normal message after the turn ends to get a human-rooted turn.

**Enforcement.** Every session is created and resumed with
`hooks.onPreToolUse = createCommsGuardHook(sessionRef)` next to the
observation hook (`src/session-manager.ts`). The SDK (1.0.28) honors
`{permissionDecision:'deny', permissionDecisionReason}`. The hook reads the
root by the Caco session id from `sessionRef`, not the hook input's
`sessionId`, so SDK sub-agent tool calls are judged by the parent turn. A
denial returns:

> Blocked: `<tool>` sends communication a person will read, and this turn was
> not started by the user. Do not retry or work around this with another tool.
> Write a draft in your reply and offer it as a caco-actions option so the user
> can send it.

Each denial logs `[COMMS-GUARD] Denied <tool> in <session8>`. It never logs
arguments.

**Modes.** Preference `commsGuard` (`POST /api/preferences`):

| mode | human-rooted turn | unattended turn |
|---|---|---|
| `unattended` (default) | allowed | denied |
| `always` | denied | denied |
| `off` | allowed | allowed |

An unknown value is ignored by `updatePreferences` and resolves to
`unattended`.

**Patterns.** Tool-name globs (`*`, case-insensitive). A pattern matches the
full model-facing name or any suffix after a server separator (`-`, `/`, `.`,
`:`, `__`), so `ReplyToMessage` matches `mail-ReplyToMessage`,
`outlook/ReplyToMessage`, and `mail__ReplyToMessage`. A `#a,b` suffix limits
the pattern to calls whose `action` argument is one of those values, for ADO's
multi-action tools. A missing `action` matches (fail closed). Preference
`commsGuardPatterns` replaces the defaults; `[]` or `null` restores them.

Defaults (`DEFAULT_COMMS_GUARD_PATTERNS`). Names were checked against
`~/.copilot/mcp-config.json` servers, the live catalog, and
`@azure-devops/mcp` 2.11.0 sources:

- Mail: `SendDraftMessage`, `SendEmail*`, `Reply*ToMessage`,
  `Reply*WithFullThread`, `ForwardMessage*`. Allowed: `CreateDraftMessage`,
  `UpdateDraft`, attachments, reads.
- Teams: `SendMessageToChat`, `SendMessageToChannel`, `SendMessageToUser`,
  `ReplyToChannelMessage`, `UpdateChatMessage`, `SendFileTo*`,
  `AddChatMember`, `AddChannelMember`, `CreateChat`. Allowed:
  `SendMessageToSelf` (Carl's own notification channel).
- ADO: `repo_create_pull_request_thread`, `repo_reply_to_comment`,
  `repo_pull_request_thread_write#create,reply,update`,
  `wit_add_work_item_comment`, `wit_update_work_item_comment`,
  `wit_work_item_comment_write#add,update`,
  `repo_update_pull_request_reviewers`,
  `repo_pull_request_write#update_reviewers`. Allowed: thread status
  (`repo_update_pull_request_thread`, `..._thread_write#update_status`), so a
  track can resolve bot threads; creating a PR; votes.
- IcM: `post_discussion_entry`, `post_incident_insight`,
  `acknowledge_incident`, `mitigate_incident`, `resolve_incident`,
  `reactivate_incident`, `transfer_incident`, `update_incident`,
  `update_incident_severity`, `request_assistance`.
- General-purpose channels that can reach mail, Teams, or the desktop:
  `workiq-do_action`, `workiq-create_entity`, `workiq-update_entity`,
  `workiq-delete_entity`, `computer-use-*`. Allowed: workiq reads (`ask`,
  `fetch`, `retrieve`, ...). In the default mode this only affects unattended
  turns, so interactive use is unchanged.

**Work item history.** Writing `System.History` posts a work item discussion
comment. A fixed rule (`WORK_ITEM_HISTORY_TOOLS`, not a pattern, so custom
patterns don't remove it) guards `wit_work_item_write`, `wit_update_work_item`,
`wit_update_work_items_batch`, `wit_create_work_item`, and
`wit_add_child_work_items` when their serialized arguments contain
`System.History` (case-insensitive). Other work item writes stay allowed.

## Invariants

1. A guarded tool never runs in a turn whose root is not a user message to
   that session, unless the mode is `off`.
2. A turn's root is fixed at its first dispatch and inherited by every
   continuation.
3. No root recorded means unattended.
4. The guard never adds, removes, or defers tools.
5. Denial logs carry the tool name and session only.

## Considerations

- The hook runs for every tool call. It does a map lookup and up to ~35 small
  regex tests; this is noise next to a model turn.
- Bare-name patterns can catch a same-named tool on another server. That errs
  toward guarding, which is the safe direction.
- Applet messages are unattended. An applet button is often Carl, but applets
  can also post on their own, and Carl can always type the request.

## Risks and Mitigations

| risk | mitigation |
|---|---|
| A new MCP server adds a send tool | The pattern list is a preference; the README names it. Unknown tools are not guarded. |
| Shell reaches comms anyway (`bash`/`powershell`, `caco_run_workflow`/`caco.sh` + curl or a CLI) | Not closable by a tool hook. The prompt rule still applies. |
| **Known bypass:** a turn with shell access can POST to the local `/api/sessions/:id/messages` route with no `source`, which starts a human-rooted turn in another session (or its own, once idle) | Can't be closed locally: a local process can forge any header or token the browser could send. The guard is defense in depth against direct tool calls and prompt injection, not a sandbox. |
| Work item `System.History` written in an unexpected argument shape | The check is a substring test over the serialized arguments, so any shape that names the field matches. |
| The SDK changes the hook contract | `comms-guard.test.ts` pins the output shape; typecheck pins the hook type. |

## Acceptance

| # | behavior | oracle |
|---|---|---|
| G1 | User message: human-rooted for the dispatch, cleared after | `session-messages-route-harness.test.ts` |
| G2 | Wake, slug, agent, system, applet: unattended | same, `it.each` |
| G3 | Continuation of a user turn stays human; of a wake stays unattended | same |
| G4 | `unattended` allows human, denies unattended; `always` denies human; `off` allows all | `comms-guard.test.ts` |
| G5 | Server-prefixed names match; `SendMessageToSelf`, `CreateDraftMessage`, thread `update_status` stay allowed | `comms-guard.test.ts` |
| G6 | Denial log has no arguments; no root fails closed | `comms-guard.test.ts` |
| G7 | Preference validation | `session-state.test.ts` |
| G8 | workiq writes and `computer-use-*` guarded; workiq reads allowed | `comms-guard.test.ts` |
| G9 | Work item writes guarded only when they set `System.History`, even with custom patterns | `comms-guard.test.ts` |

## Plan

| phase | scope | status |
|---|---|---|
| 1 | `src/comms-guard.ts`, hook wiring, dispatch root, preferences, tests, docs | done |
| 2 | General-purpose channels, `System.History` rule, documented shell bypass | done |
