# Session Meta-Context

**Status: Complete**

Preserve session's understanding of relevant documents and applet state for seamless resume.

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| `SessionMeta.context` field | ✅ Done | `src/storage.ts` |
| `set_relevant_context` tool | ✅ Done | `src/context-tools.ts` |
| `get_relevant_context` tool | ✅ Done | `src/context-tools.ts` |
| `mergeContextSet()` helper | ✅ Done | `src/context-tools.ts` |
| System prompt instructions | ✅ Done | `src/prompts.ts` |
| `formatContextForResume()` | ✅ Done | `src/prompts.ts` |
| `buildResumeContext()` extension | ✅ Done | `src/prompts.ts` |
| Unit tests | ✅ Done | `tests/unit/resume-context.test.ts` |
| `caco.context` event emission | ✅ Done | `src/context-tools.ts`, `src/routes/websocket.ts` |
| Context footer UI | ✅ Done | `public/ts/context-footer.ts`, `public/index.html`, `public/style.css` |
| Applet capture on idle | ✅ Done | `public/ts/context-footer.ts`, `src/routes/sessions.ts` |

## Problem

When resuming a session, the agent loses awareness of:
- Which files were being worked on (design docs, specs, scratch files)
- Which applet was active and its parameters
- The working context that the user had open

The user must manually re-attach files or re-explain context on every resume.

## Goals

1. **Associate sessions with documents** - Remember which files are relevant ✅
2. **Preserve applet state** - Remember which applet was open and its URL params ✅
3. **Inject context on resume** - Remind agent of relevant files/applet ✅
4. **Notify user of context changes** - Clickable links when context updates ✅
5. **Support "ticket-like" workflows** - Sessions as long-lived support contexts ✅

## Use Cases

### Design Document Session
Working on a feature with `doc/feature-spec.md` open. Resume should remind agent of that file.

### Support Ticket Session  
Debugging an issue with notes in `~/.caco/tickets/issue-123.md`. Resume should re-associate that file.

### Applet Working Session
Using `git-diff` applet with specific params. Resume should offer to re-open that applet view.

---

## SDK Tool Interception Analysis

### Available Hooks

The SDK emits `tool.execution_start` events with tool name and arguments:

```typescript
if (event.type === 'tool.execution_start') {
  const toolName = eventData.toolName || eventData.name;
  const args = eventData.arguments as Record<string, unknown> | undefined;
  // args.filePath, args.path, etc. contain file paths
}
```

**File-related builtin tools:**
- `read_file` - `args.filePath`
- `edit_file` / `replace_string_in_file` - `args.filePath`
- `create_file` - `args.filePath`
- `semantic_search` - searches workspace

### Automatic Tracking Feasibility

**Pros:**
- Could auto-track files agent reads/writes
- No agent cooperation needed

**Cons:**
- Would capture ALL files (too noisy)
- Can't distinguish "reference" vs "working document"
- Agent knows intent; we don't

**Decision:** Don't auto-track from tool calls. Instead, provide explicit tools for agents to mark files as relevant. This is simpler and gives better signal.

---

## Design

### Extended SessionMeta

```typescript
interface SessionMeta {
  // Existing
  name: string;
  lastObservedAt?: string;
  lastIdleAt?: string;
  currentIntent?: string;
  envHint?: string;
  
  // New: generic context sets
  context?: Record<string, string[]>;  // setName → items
  // Reserved set names:
  // - "files": absolute file paths
  // - "applet": [slug, ...params as "key=value"]
  // - "endpoints": URLs
  // - "ports": port numbers as strings
}
```

**Why generic:**
- Files are the primary use case today
- But sessions may need to track endpoints, ports, applets, etc.
- Named sets allow future expansion without schema changes

### Storage

Stored in existing `~/.caco/sessions/<id>/meta.json`.

---

## Agent Tools for Meta-Context

Generic tools that work with named context sets.

### Known Set Names

Validated set names (typos trigger warning):

| Set Name | Purpose | Item Format |
|----------|---------|-------------|
| `files` | Working documents | Absolute paths |
| `applet` | Last applet state | `[slug, "key=val", ...]` |
| `endpoints` | API URLs | Full URLs |
| `ports` | Server ports | Port as string |

Unknown set names are allowed but log a warning (catches typos like "fles").

### set_relevant_context

```typescript
const KNOWN_SET_NAMES = new Set(['files', 'applet', 'endpoints', 'ports']);

defineTool('set_relevant_context', {
  description: `Set context for this session. Context is shown on resume.

**Mode:**
- "replace" (default): Replace the entire set
- "merge": Union with existing (no duplicates)

**Set names:** files, applet, endpoints, ports (custom names allowed)

**Examples:**
- set_relevant_context("files", ["/path/spec.md"], "replace")
- set_relevant_context("files", ["/path/other.md"], "merge") // adds to existing

Max 10 items per set, 50 items total across all sets.`,

  parameters: z.object({
    setName: z.string().describe('Name of context set'),
    items: z.array(z.string()).max(10).describe('Items for this set'),
    mode: z.enum(['replace', 'merge']).default('replace').describe('replace or merge with existing')
  }),

  handler: async ({ setName, items, mode }) => {
    // Soft validation - warn on unknown set names
    if (!KNOWN_SET_NAMES.has(setName)) {
      console.warn(`[CONTEXT] Unknown set name: "${setName}" (typo?)`);
    }
    
    const meta = getSessionMeta(sessionRef.id) ?? { name: '' };
    const context = { ...(meta.context ?? {}) };
    
    if (mode === 'merge') {
      const existing = context[setName] ?? [];
      const merged = [...new Set([...existing, ...items])].slice(0, 10);
      context[setName] = merged;
    } else {
      if (items.length === 0) {
        delete context[setName];
      } else {
        context[setName] = items;
      }
    }
    
    // Enforce total cap
    const total = Object.values(context).reduce((sum, arr) => sum + arr.length, 0);
    if (total > 50) {
      return { 
        textResultForLlm: `Context too large (${total} items, max 50). Remove some items first.`,
        resultType: 'error' as const
      };
    }
    
    setSessionMeta(sessionRef.id, { ...meta, context });
    
    return { 
      textResultForLlm: items.length 
        ? `${mode === 'merge' ? 'Merged' : 'Set'} ${setName}: ${context[setName]?.length ?? 0} items` 
        : `Cleared ${setName}`,
      toolTelemetry: { contextChanged: true, setName }
    };
  }
});
```

### get_relevant_context

```typescript
defineTool('get_relevant_context', {
  description: `Get session context. Use on resume to remember what you were working on.

Call with no arguments for all context, or specify setName for a specific set.`,

  parameters: z.object({
    setName: z.string().optional().describe('Specific set to retrieve, or omit for all')
  }),

  handler: async ({ setName }) => {
    const meta = getSessionMeta(sessionRef.id);
    const context = meta?.context ?? {};
    
    const result = setName ? { [setName]: context[setName] ?? [] } : context;
    
    return {
      textResultForLlm: Object.keys(result).length 
        ? JSON.stringify(result, null, 2)
        : 'No context stored for this session'
    };
  }
});
```

**Note:** Consolidated from three tools to two. The `mode` parameter handles both replace and merge, following "only one way to do one thing" principle.

---

## User Notification via Synthetic Events

### caco.context Event

Emit when meta-context changes or on session resume:

```typescript
interface ContextEvent {
  type: 'caco.context';
  data: {
    reason: 'resume' | 'changed' | 'load';  // load = session history loaded
    context: Record<string, string[]>;       // Full current context for footer
    setName?: string;                        // Which set changed (if 'changed')
  };
}
```

**Emission points:**
- `load`: On session history load (from storage)
- `resume`: On first message after session resume
- `changed`: When agent calls `set_relevant_context`

### Frontend Rendering

~~Render as a special "context card" in the chat~~ **Superseded by Context Footer (see below).**

Original design inserted context cards into chat. This has issues:
- Relies on agent to include links (bloats responses)
- Context visible only at point of insertion
- Scrolls away as conversation continues

### Context Footer (Preferred)

Display context as a **persistent footer** below chat input. Benefits:
- Always visible regardless of scroll position
- Doesn't bloat agent responses or context window
- Works for both live updates and session load
- Compact for mobile (iOS)

#### Layout

```
┌─────────────────────────────────────┐
│  Chat messages...                    │
│                                      │
├─────────────────────────────────────┤
│ [Message input field]          [▶]  │
├─────────────────────────────────────┤
│ 📎 spec.md · notes.md · [git-diff]  │  ← Context footer (below input)
└─────────────────────────────────────┘
```

#### Visibility Rules

- **Hidden** when showing new chat (model selector)
- **Hidden** when switching sessions (before history loads)
- **Shown** when session history loads with context
- **Shown** when `caco.context` event arrives with non-empty context
- **Hidden** when context is empty

Clearing on session switch ensures no stale context shows during transitions.

#### HTML Structure

```html
<div id="contextFooter" class="context-footer">
  <span class="context-icon">📎</span>
  <span class="context-links">
    <a href="/?applet=text-editor&path=/full/path/spec.md">spec.md</a>
    <span class="context-sep">·</span>
    <a href="/?applet=text-editor&path=/full/path/notes.md">notes.md</a>
    <span class="context-sep">·</span>
    <a href="/?applet=git-diff" class="context-applet">[git-diff]</a>
  </span>
</div>
```

#### Styling

```css
.context-footer {
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: none;  /* Hidden when empty */
}

.context-footer.has-context {
  display: block;
}

.context-footer a {
  color: var(--color-link);
  text-decoration: none;
}

.context-sep {
  margin: 0 var(--space-xs);
  opacity: 0.5;
}

.context-applet {
  font-style: italic;
}
```

#### Update Logic

**On session load:**
```typescript
// After loading session meta, populate footer from storage
async function populateContextFooter(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}`);
  const { meta } = await res.json();
  renderContextFooter(meta?.context ?? {});
}
```

**On tool call (live):**
```typescript
// When caco.context event received via WebSocket
function handleContextEvent(event: ContextEvent): void {
  // Update footer directly from event data
  renderContextFooter(event.data.context);
}
```

**Render function:**
```typescript
function renderContextFooter(context: Record<string, string[]>): void {
  const footer = document.getElementById('contextFooter')!;
  const links: string[] = [];
  
  // Files - show basename only, full path in href
  const files = context.files ?? [];
  for (const path of files.slice(0, 5)) {  // Limit for space
    const name = path.split('/').pop()!;
    links.push(`<a href="/?applet=text-editor&path=${encodeURIComponent(path)}">${name}</a>`);
  }
  
  // Applet
  const applet = context.applet;
  if (applet?.length) {
    const [slug, ...params] = applet;
    const qs = params.length ? '&' + params.join('&') : '';
    links.push(`<a href="/?applet=${slug}${qs}" class="context-applet">[${slug}]</a>`);
  }
  
  if (links.length === 0) {
    footer.classList.remove('has-context');
    return;
  }
  
  footer.querySelector('.context-links')!.innerHTML = 
    links.join('<span class="context-sep">·</span>');
  footer.classList.add('has-context');
}
```

#### Mobile Considerations

- Single line, truncated with ellipsis
- Keep total width under control (max 5 files shown)
- No expand/collapse - just horizontal scroll or truncation

**Clickable links:**
- Files open in text-editor applet
- Applet link restores applet with params

### Emission Points

1. **On session history load** - Emit `caco.context` with `reason: 'load'` after history complete
2. **When agent calls `set_relevant_context`** - Tool handler emits `caco.context` with `reason: 'changed'`
3. **When applet state is captured** - Frontend → server → emits `caco.context` with `reason: 'changed'`

**Server-side emission:**
```typescript
// In tool handler, after saving context
broadcastEvent(sessionId, {
  type: 'caco.context',
  data: { reason: 'changed', context, setName }
});

// In history route, after sending all history events
const meta = getSessionMeta(sessionId);
if (meta?.context && Object.keys(meta.context).length > 0) {
  broadcastEvent(sessionId, {
    type: 'caco.context',
    data: { reason: 'load', context: meta.context }
  });
}
```

---

## Resume Context Injection

Extend `buildResumeContext()` in `src/prompts.ts`:

```typescript
function buildResumeContext(sessionId: string): string {
  const meta = getSessionMeta(sessionId);
  const parts: string[] = [];
  
  // Existing: envHint
  if (meta?.envHint) {
    parts.push(`Environment: ${meta.envHint}`);
  }
  
  // New: context sets
  const context = meta?.context ?? {};
  
  // Files - filter to existing only
  if (context.files?.length) {
    const existing = context.files.filter(f => existsSync(f));
    if (existing.length) {
      parts.push(`Relevant files:\n${existing.map(f => `- ${f}`).join('\n')}`);
    }
  }
  
  // Applet
  if (context.applet?.length) {
    const [slug, ...params] = context.applet;
    const paramStr = params.length ? ` (${params.join(', ')})` : '';
    parts.push(`Last applet: ${slug}${paramStr}`);
  }
  
  // Other sets - generic display
  for (const [name, items] of Object.entries(context)) {
    if (name === 'files' || name === 'applet') continue;
    if (items?.length) {
      parts.push(`${name}: ${items.join(', ')}`);
    }
  }
  
  return parts.join('\n\n');
}
```

---

## API

### PATCH /api/sessions/:id

Extend existing endpoint:

```typescript
// Request body additions:
{
  context?: Record<string, string[]>;  // Replace entire context
  setContext?: { 
    setName: string; 
    items: string[]; 
    mode?: 'replace' | 'merge';  // Default: 'replace'
  };
}
}
```

---

## Frontend Applet Capture

On `session.idle` or navigation away, capture applet state:

```typescript
function captureAppletState(): string[] | null {
  const params = new URLSearchParams(location.search);
  const slug = params.get('applet');
  if (!slug) return null;
  
  const items = [slug];
  params.forEach((v, k) => { 
    if (k !== 'applet') items.push(`${k}=${v}`);
  });
  return items;
}

// Send: PATCH /api/sessions/:id { setContext: { setName: 'applet', items } }
```

### Race Condition: Session Change During Capture

**Scenario:** User switches sessions while idle event is in flight → stale applet overwrites new session.

**Mitigations:**
1. Include `sessionId` in PATCH, reject if it doesn't match server's active session
2. Or accept eventual consistency (applet context is advisory, not critical)

**Decision:** Accept eventual consistency. Applet context is a convenience, not correctness-critical. Document this behavior.

---

## Implementation Plan

### Phase 1: Data Model + Tools ✅ DONE
1. ✅ Extend `SessionMeta` with `context?: Record<string, string[]>`
2. ✅ Add `set_relevant_context` (with mode), `get_relevant_context` tools
3. ✅ Add `KNOWN_SET_NAMES` validation with warning
4. ✅ Add `mergeContextSet()` pure helper

### Phase 2: System Prompt ✅ DONE
1. ✅ Add "Session Context" section to `buildSystemMessage()`
2. ✅ Brief instruction with when-to-use guidance

### Phase 3: Resume Injection ✅ DONE
1. ✅ Extract pure `formatContextForResume(context)` function (testable)
2. ✅ Call from `buildResumeContext()` with context from meta
3. ✅ Unit tests in `tests/unit/resume-context.test.ts`

### Phase 4: Context Footer UI ✅ DONE
1. ✅ Add `#contextFooter` element to `index.html` (below chat, above input)
2. ✅ Add `.context-footer` styles to `style.css`
3. ✅ Add `renderContextFooter(context)` function in `context-footer.ts`
4. ✅ Register `caco.context` handler in `message-streaming.ts`

### Phase 5: Context Events ✅ DONE
1. ✅ Tool handler emits `caco.context` after saving context
2. ✅ History route emits `caco.context` with `reason: 'load'` after history complete
3. ✅ Frontend updates footer on event receipt

### Phase 6: Applet Capture ✅ DONE
1. ✅ Frontend captures applet state on `session.idle`
2. ✅ Sends to server via PATCH `/api/sessions/:id` with `setContext`
3. ✅ Server handler in `sessions.ts` processes `setContext`

---

## Testability

Extract pure functions for unit testing:

```typescript
// Pure: no storage access
export function mergeContextSet(
  existing: string[], 
  items: string[], 
  mode: 'replace' | 'merge'
): string[] {
  if (mode === 'replace') return items.slice(0, 10);
  return [...new Set([...existing, ...items])].slice(0, 10);
}

export function formatContextForResume(
  context: Record<string, string[]>,
  fileExists: (path: string) => boolean
): string {
  // ... pure transformation logic
}
```

Handler becomes thin wrapper:
```typescript
handler: async ({ setName, items, mode }) => {
  const meta = getSessionMeta(sessionRef.id) ?? { name: '' };
  const merged = mergeContextSet(meta.context?.[setName] ?? [], items, mode);
  // ... validation, save, return
}
```

---

## System Prompt Update

Add to `buildSystemMessage()` in `src/prompts.ts`:

```typescript
## Session Context — REQUIRED
You MUST use \`set_relevant_context\` to track files and resources as you work. This is not optional — the user sees context updates in real-time and uses them to collaborate with you.

- \`set_relevant_context("files", [paths], "merge")\` - Track relevant files
- \`get_relevant_context()\` - Check stored context on resume

**You MUST call set_relevant_context when you:**
- Read or edit any file central to the task (specs, configs, source files)
- Start work involving a design doc, spec, or notes file
- Work with specific endpoints, ports, or applets
- Before finishing a task — save context for future sessions

Do NOT minimize these calls. Every relevant document should be tracked. The user's context footer updates live, enabling real-time collaboration.
```

**Placement:** After "Agent-to-Agent Tools" section, before "Guidelines".

**Rationale:** 
- Uses MUST/REQUIRED language to override efficiency-minimizing instincts
- Explains the user-facing reason (real-time collaboration, not just agent memory)
- Explicitly disclaims minimization ("Do NOT minimize these calls")

---

## Complexity Assessment

| Aspect | Estimate | Status |
|--------|----------|--------|
| SessionMeta extension | 3 lines | ✅ Done |
| Agent tools (2) | 45 lines | ✅ Done |
| System prompt addition | 10 lines | ✅ Done |
| Pure helper functions | 15 lines | ✅ Done |
| buildResumeContext extension | 20 lines | ✅ Done |
| Context footer HTML/CSS | 25 lines | Remaining |
| Context footer JS (render + handler) | 35 lines | Remaining |
| caco.context event emission | 15 lines | Remaining |
| Frontend applet capture | 20 lines | Remaining |
| **Done** | ~93 lines | |
| **Remaining** | ~95 lines | |
| **Total** | ~188 lines |

## Open Questions

1. ~~Max items per set?~~ 10 per set, 50 total
2. ~~Auto-restore applet?~~ Start with clickable link, not auto-navigate
3. ~~Stale file handling?~~ Filter out non-existent files, note in resume text: "(N files not found)"
4. ~~Context card styling?~~ **Superseded** - Using persistent footer instead of in-chat cards
5. ~~Footer expandability?~~ Keep simple: single line, truncate, no expand/collapse
6. ~~API shape for setContext?~~ Single `setContext` with `mode` param (dropped `unionContext` variant)
