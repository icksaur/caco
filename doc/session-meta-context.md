# Session Meta-Context

Preserve session's understanding of relevant documents and applet state for seamless resume.

## Problem

When resuming a session, the agent loses awareness of:
- Which files were being worked on (design docs, specs, scratch files)
- Which applet was active and its parameters
- The working context that the user had open

The user must manually re-attach files or re-explain context on every resume.

## Goals

1. **Associate sessions with documents** - Remember which files are relevant
2. **Preserve applet state** - Remember which applet was open and its URL params
3. **Inject context on resume** - Remind agent of relevant files/applet
4. **Notify user of context changes** - Clickable links when context updates
5. **Support "ticket-like" workflows** - Sessions as long-lived support contexts

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
    reason: 'resume' | 'changed';
    files?: string[];
    addedFile?: string;
    removedFile?: string;
    applet?: { slug: string; params?: Record<string, string> };
  };
}
```

### Frontend Rendering

Render as a special "context card" in the chat:

```html
<div class="context-card">
  <span class="context-label">Session context:</span>
  <ul>
    <li><a href="/?applet=text-editor&path=/home/user/doc/spec.md">doc/spec.md</a></li>
    <li><a href="/?applet=text-editor&path=/home/user/notes.md">notes.md</a></li>
  </ul>
  <a href="/?applet=git-diff&path=/repo">Restore git-diff applet</a>
</div>
```

**Clickable links:**
- Files open in text-editor applet
- Applet link restores applet with params

### Emission Points

1. **On session resume** (first message after resume flag set)
2. **When agent calls `set_relevant_files` or `add_relevant_file`**
3. **When applet state is captured** (frontend → server → event)

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
  setContext?: { setName: string; items: string[] };  // Set one set
  unionContext?: { setName: string; items: string[] };  // Union one set
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

### Phase 1: Data Model + Tools (~45 lines)
1. Extend `SessionMeta` with `context?: Record<string, string[]>`
2. Add `set_relevant_context` (with mode), `get_relevant_context` tools
3. Add `KNOWN_SET_NAMES` validation with warning

### Phase 2: System Prompt (~10 lines)
1. Add "Session Context" section to `buildSystemMessage()`
2. Brief instruction with when-to-use guidance

### Phase 3: Context Events (~30 lines)
1. Define `caco.context` event type
2. Tool handler returns `toolTelemetry: { contextChanged }`, caller emits event
3. Frontend renders context cards with clickable links

### Phase 4: Resume Injection (~20 lines)
1. Extract pure `formatContextForResume(context)` function (testable)
2. Call from `buildResumeContext()`

### Phase 5: Applet Capture (~20 lines)
1. Frontend captures applet state on idle
2. Sends to server as `setContext: { setName: 'applet', items }`

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
## Session Context
Track important files and resources for session continuity:
- \`set_relevant_context("files", [paths], "merge")\` - Mark files as relevant
- \`get_relevant_context()\` - Check what context is stored

**When to use:**
- Starting work on a spec, design doc, or notes file
- User explicitly asks you to remember a file
- Working with specific endpoints or ports

Context is shown to you on session resume, so you don't forget what you were working on.
```

**Placement:** After "Agent-to-Agent Tools" section, before "Guidelines".

**Rationale:** 
- Concise instruction with examples
- Explains the benefit ("so you don't forget")
- Doesn't mandate usage, but suggests when appropriate

---

## Complexity Assessment

| Aspect | Estimate |
|--------|----------|
| SessionMeta extension | 3 lines |
| Agent tools (2) | 45 lines |
| System prompt addition | 10 lines |
| Pure helper functions | 15 lines |
| caco.context event + emit | 20 lines |
| Context card rendering | 30 lines |
| buildResumeContext extension | 20 lines |
| Frontend applet capture | 20 lines |
| **Total** | ~163 lines |

## Open Questions

1. ~~Max items per set?~~ 10 per set, 50 total
2. **Auto-restore applet?** Start with clickable link, not auto-navigate
3. **Stale file handling?** Filter out non-existent files, note in resume text: "(N files not found)"
4. **Context card styling?** Subtle, collapsible, distinct from assistant messages
