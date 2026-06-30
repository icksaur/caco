# spec-chat-form

The chat **input form** subsystem: per-form controllers, popups, and persistent
drafts. As-built (R1→R2→R3→R3.5 refactors + draft persistence, all shipped); this
consolidates and replaces the historical series. Transcript rendering is out of
scope (see `spec-chat-render-cap`).

## Goals

Two chat forms — the new-chat form and the active-session form — each behave
independently: type-ahead slash/pound/picker popups, autosizing textarea, submit,
and a draft that survives reload. No cross-form state bleed. A user typing in one
session and switching away never sees that text appear in another form.

## Design

**One controller per form.** `ChatFormController` (`public/ts/chat-form-controller.ts`)
owns a single form's textarea, submit, draft cache, response-options rendering
(`renderResponseOptions`), and its popups. `main.ts` constructs exactly two (new-chat
+ active-session); nothing lives on module globals. Mechanism: per-instance state
(chosen over the old module-global `setupMultilineInput`) so two forms can't share
mutable state — the root cause of the historical draft-bleed bug.

**One popup set per form.** `FormPopups` (`chat-form-popups.ts`), owned by the
controller, manages the slash-command, pound (`#`-mention), and picker popups. The
controller defers keydown to `popups.handleKey(e)` while one is visible. `autoResize`
and `formatSlashPickerValue` are utilities here; `multiline-input.ts` is now a thin
shell holding only the `registerPoundProvider` registry.

**Drafts.** `chat-draft-api.ts` exposes `getDraft/putDraft/deleteDraft(sessionId)`;
`sessionId === null` addresses the new-chat draft. Storage is plain UTF-8 text:
per-session `~/.caco/sessions/<id>/chat-draft.txt`, new-chat `~/.caco/drafts/newchat.txt`.
File existence = a draft exists; empty input deletes the file. Saves fire on the
textarea `input` event, debounced 1000 ms. Writes are **serialized through a single
async queue** (`_resetDraftQueueForTests` guards it in tests) so a late write can
never clobber a newer one or land in the wrong session.

## Invariants

- **No cross-form/module-global state** (invariant): each form's textarea, draft,
  and popups are per-`ChatFormController`; code rots toward shared globals (the
  draft-bleed regression). 
- **Draft is keyed strictly by binding** (invariant): a draft write targets the
  session that produced it; switching forms mid-edit never reassigns it.
- **Write ordering** (invariant): draft persistence is queue-serialized; out-of-order
  writes must not clobber newer state.
- **Absent draft file = no draft** (fact): existence is the only flag; empty → delete.
- **Plain-text storage** (mechanism): no JSON envelope (content is just a string).

## Considerations

The new-chat draft is intentionally **not** CWD-keyed — one global scratchpad that
survives CWD switches (by design, not a bug). Multi-tab: last writer wins per the
serialized queue. Resume folds the draft via `seedDraft` is deferred (not queue-safe
yet) — see `r4-resume-bundle-spec` Slice B.

## Risks and Mitigations

- Draft bleed between forms → per-controller state + binding-keyed writes; covered by draft-api tests.
- Lost keystrokes on rapid switch → debounce flush on blur/submit before rebinding.

## Acceptance

- Observable: type in session A, switch to B — B's textarea shows B's draft, not A's; reload restores each form's draft.
- Gates: typecheck ×2, lint:strict, full tests, build:client.
- Oracles: draft-api unit tests (get/put/delete, null=new-chat, queue ordering via `_resetDraftQueueForTests`); controller binding tests (no cross-form bleed).

## Plan

As-built; rows map the shipped subsystem.

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Per-form `ChatFormController` (off module globals) | `public/ts/chat-form-controller.ts`, `main.ts` | binding test: two forms, no shared state |
| 2 | Per-form `FormPopups` (slash/pound/picker) | `public/ts/chat-form-popups.ts` | popup key-handling test |
| 3 | Draft persistence API + serialized queue | `public/ts/chat-draft-api.ts` | draft-api test: ordering, null=new-chat |
| 4 | `multiline-input` reduced to pound-provider registry | `public/ts/multiline-input.ts` | by-construction |

## Rationale

Consolidates the historical series (archived): `chat-draft-persistence` (original
feature), `chat-draft-refactor`, `chat-form-refactor` (R1+R3), `chat-form-r3.5`
(relocate per-form behaviour off module globals), and their review artifacts. The
draft-bleed postmortem drove the per-form-instance invariant; the queue-serialized
writes close the ordering hole.
