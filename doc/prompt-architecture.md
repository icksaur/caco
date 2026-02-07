# Prompt Architecture Analysis

## Current State: Prompt Sources

There are **5 distinct prompt injection points** in Caco, each handled differently:

### 1. System Message (session creation)
**Location**: `server.ts` → `buildSystemMessage()`
**When**: Once at server startup, cached globally
**Contents**:
- Environment info (HOME, CWD)
- Capability summary (filesystem, terminal, images, embeds)
- Applet list from `getAppletSlugsForPrompt()`
- Agent-to-agent tool hints
- Behavior guidelines

**Problem**: Static at startup. Applet list doesn't update if applets change.

### 2. Resume Context (session resume)
**Location**: `src/resume-context.ts` → `buildResumeContext()`
**When**: First message after `resume()` called
**Contents**:
- `[SESSION RESUMED]` header
- Shell reset warning
- Session cwd
- Optional `envHint` from SessionMeta

**Mechanism**: Prepended to user message in `sendStream()`

### 3. Message Source Prefix (per-message)
**Location**: `src/message-source.ts` → `prefixMessageSource()`
**When**: Every message from non-user sources
**Contents**:
- `[applet:slug]` - from applet iframes
- `[agent:sessionId]` - from agent-to-agent tools
- `[scheduler:slug]` - from scheduled jobs

**Mechanism**: Prepended in `session-messages.ts` before send

### 4. Applet Discovery (in system message)
**Location**: `src/applet-store.ts` → `getAppletSlugsForPrompt()`
**When**: At server startup (cached in system message)
**Contents**: `Available applets: file-browser, git-status, ...`

**Problem**: Just slugs, no params. Agent must call `list_applets` tool.

### 5. Per-Session Configuration
**Location**: `src/types.ts` → `SessionConfig`
**When**: Session create/resume
**Contents**: `systemMessage`, `toolFactory`, `excludedTools`

---

## Problems Identified

### 1. Scattered Logic
Prompt building is spread across 5 files:
- `server.ts` (system message builder)
- `resume-context.ts` (resume prefix)
- `message-source.ts` (source prefix)
- `applet-store.ts` (applet listing)
- `session-manager.ts` (orchestration)

### 2. Static vs Dynamic
- System message built once at startup
- Applet list stale if applets added/removed
- No per-session customization of system message

### 3. No Composability
Each prompt piece is hardcoded. Can't easily:
- Add new context sources
- Disable certain parts
- Order/prioritize sections

### 4. Different Mechanisms
- System message: SDK `createSession({ systemMessage })`
- Resume context: Prepend to user prompt
- Source prefix: Prepend to user prompt
- No unified approach

---

## Proposed Consolidation

### Option A: Prompt Registry Pattern

Create a central registry of "prompt providers" that contribute sections:

```typescript
// src/prompt-registry.ts

interface PromptSection {
  id: string;
  priority: number;  // Lower = earlier in output
  type: 'system' | 'per-message' | 'on-resume';
  content: () => string | Promise<string>;
  enabled?: () => boolean;
}

class PromptRegistry {
  private sections: PromptSection[] = [];
  
  register(section: PromptSection): void {
    this.sections.push(section);
    this.sections.sort((a, b) => a.priority - b.priority);
  }
  
  async buildSystemMessage(): Promise<string> {
    const parts = [];
    for (const s of this.sections.filter(s => s.type === 'system')) {
      if (s.enabled?.() !== false) {
        parts.push(await s.content());
      }
    }
    return parts.join('\n\n');
  }
  
  async buildResumeContext(sessionId: string): Promise<string> {
    const parts = [];
    for (const s of this.sections.filter(s => s.type === 'on-resume')) {
      if (s.enabled?.() !== false) {
        parts.push(await s.content());
      }
    }
    return parts.join('\n\n');
  }
  
  buildMessagePrefix(source: MessageSource, id: string): string {
    // ... source prefix logic
  }
}

// Registration
promptRegistry.register({
  id: 'environment',
  priority: 10,
  type: 'system',
  content: () => `## Environment\n- Home: ${homedir()}\n- CWD: ${process.cwd()}`
});

promptRegistry.register({
  id: 'applets',
  priority: 50,
  type: 'system',
  content: async () => {
    const slugs = await getAppletSlugs();
    return `## Applets\nAvailable: ${slugs.join(', ')}`;
  }
});

promptRegistry.register({
  id: 'resume-warning',
  priority: 10,
  type: 'on-resume',
  content: () => `[SESSION RESUMED]\nShell state reset.`
});
```

### Benefits:
- All prompt logic discoverable in one place
- Easy to add/remove sections
- Dynamic content (applets refresh on each build)
- Testable sections in isolation
- Clear priority ordering

### Option B: Simpler Approach - Single Builder Module

Keep current pattern but consolidate into one module:

```typescript
// src/prompts.ts

export function buildSystemMessage(): SystemMessage {
  return {
    mode: 'replace',
    content: [
      buildEnvironmentSection(),
      buildCapabilitiesSection(),
      buildAppletSection(),
      buildAgentToolsSection(),
      buildGuidelinesSection(),
    ].join('\n\n')
  };
}

export function buildResumeContext(sessionId: string): string {
  const meta = getSessionMeta(sessionId);
  return [
    '[SESSION RESUMED]',
    'Shell state reset. Re-run setup commands.',
    `CWD: ${meta?.cwd}`,
    meta?.envHint ? `Hint: ${meta.envHint}` : '',
  ].filter(Boolean).join('\n');
}

export function buildMessagePrefix(source: MessageSource, id: string): string {
  if (source === 'user') return '';
  return `[${source}:${id}] `;
}
```

### Benefits:
- Simple to understand
- All prompt text in one file
- Easy to review/modify
- Less abstraction overhead

---

## Recommendation

**Start with Option B** (single module). It's lower risk and addresses the main issue (scattered logic). If we later need dynamic registration, we can evolve to Option A.

### Implementation Steps

1. Create `src/prompts.ts` with all prompt-building functions
2. Move `buildSystemMessage` from `server.ts`
3. Move `buildResumeContext` from `resume-context.ts`
4. Move `prefixMessageSource` from `message-source.ts`
5. Move `getAppletSlugsForPrompt` from `applet-store.ts`
6. Update imports in consuming files
7. Delete old files (keep `resume-context.ts` tests, update imports)

### Future Enhancements

- **Dynamic system message**: Rebuild on applet changes
- **Per-session overrides**: Custom system message per session
- **Prompt templates**: User-configurable prompt sections
- **copilot-instructions.md**: Auto-inject project instructions

---

## Status

- [x] Analyze current prompt sources
- [x] Document scattered locations
- [x] Propose consolidation options
- [x] Implement Option B (single module) - `src/prompts.ts`
- [x] Update tests
- [ ] Consider dynamic system message refresh
