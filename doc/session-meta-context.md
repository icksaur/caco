# Session Meta-Context

**Status: Complete**

Preserve session's understanding of relevant documents and applet state for seamless resume.

## Problem

When resuming a session, the agent loses awareness of:
- Which files were being worked on (design docs, specs, scratch files)
- Which applet was active and its parameters
- The working context that the user had open

## Goals

1. **Associate sessions with documents** — Remember which files are relevant
2. **Preserve applet state** — Remember which applet was open and its URL params
3. **Inject context on resume** — Remind agent of relevant files/applet
4. **Notify user of context changes** — Clickable links when context updates
5. **Support "ticket-like" workflows** — Sessions as long-lived support contexts

## Design

### Extended SessionMeta

```typescript
interface SessionMeta {
  name: string;
  lastObservedAt?: string;
  lastIdleAt?: string;
  currentIntent?: string;
  envHint?: string;
  context?: Record<string, string[]>;  // setName → items
}
```

Generic context sets allow future expansion without schema changes.

### Known Set Names

| Set Name | Purpose | Item Format |
|----------|---------|-------------|
| `files` | Working documents | Absolute paths |
| `applet` | Last applet state | `[slug, "key=val", ...]` |
| `endpoints` | API URLs | Full URLs |
| `ports` | Server ports | Port as string |

Unknown set names are allowed but log a warning (catches typos).

### Agent Tools

- **`set_relevant_context(setName, items, mode)`** — Replace or merge a context set. Max 10 items per set, 50 total.
- **`get_relevant_context(setName?)`** — Retrieve one or all context sets.

### Context Event

`caco.context` event emitted on context changes and session load:

| Reason | When |
|--------|------|
| `load` | Session history loaded from storage |
| `resume` | First message after session resume |
| `changed` | Agent calls `set_relevant_context` |

### Context Footer

Persistent footer below chat input showing tracked files and applet as clickable links. Always visible regardless of scroll position. Hidden when context is empty.

### Resume Context Injection

`buildResumeContext()` reads `SessionMeta.context` and injects relevant files, applet state, and other context sets into the system prompt on session resume. Non-existent files are filtered out.

### Applet Capture

On `session.idle`, frontend captures current applet state (slug + URL params) and sends to server via `PATCH /api/sessions/:id`.

## Key Files

| File | Purpose |
|------|---------|
| `src/context-tools.ts` | `set_relevant_context`, `get_relevant_context` tools, `mergeContextSet()` |
| `src/prompts.ts` | `formatContextForResume()`, `buildResumeContext()` extension |
| `src/storage.ts` | `SessionMeta.context` field |
| `src/routes/websocket.ts` | `caco.context` event broadcast |
| `src/routes/sessions.ts` | `setContext` handler in PATCH endpoint |
| `public/ts/context-footer.ts` | `renderContextFooter()`, applet capture |
| `tests/unit/resume-context.test.ts` | Unit tests |
