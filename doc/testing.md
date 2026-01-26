# Testing Strategy: copilot-web

## The Question

> My unit testing on backend C# is almost always: have logic in scoped behavior class, mock dependencies/IO, write tests that ensure class serves its purpose. Is testing this kind of app different?

Short answer: **Not fundamentally, but our architecture fights it.**

Your C# pattern is solid: isolate behavior, mock the world, verify the contract. The problem isn't web vs backend—it's that **we don't have scoped behavior classes**. Our code is procedural with global state, making the "mock dependencies" step painful.

---

## Architecture Analysis

Let me map the codebase to your mental model:

### Server-Side Files

| File | Lines | Pure Logic? | Dependencies | Unit Testable? |
|------|-------|-------------|--------------|----------------|
| `oembed.ts` | 148 | ✅ Yes | `fetch` only | ✅ Easy - mock fetch |
| `output-cache.ts` | 81 | ✅ Yes | None (in-memory) | ✅ Easy - pure functions |
| `preferences.ts` | 55 | ⚠️ Mostly | `fs` for load/save | ⚠️ Extract file I/O |
| `display-tools.ts` | 290 | ❌ No | `fs`, `exec`, SDK tools | ❌ Hard - deeply coupled |
| `session-manager.ts` | 509 | ❌ No | `fs`, SDK client, global state | ❌ Hard - singleton + I/O |
| `session-state.ts` | 266 | ❌ No | `session-manager`, SDK | ❌ Hard - depends on singleton |
| `routes/*.ts` | ~300 | ❌ No | All of the above | ❌ Integration only |

### Client-Side Files

| File | Lines | Pure Logic? | Dependencies | Unit Testable? |
|------|-------|-------------|--------------|----------------|
| `ui-utils.ts` | 53 | ✅ Yes | None | ✅ Easy - pure functions |
| `state.ts` | 181 | ✅ Yes | None | ✅ Easy - pure state machine |
| `activity.ts` | 96 | ❌ No | DOM only | ⚠️ Need JSDOM |
| `display-output.ts` | 154 | ❌ No | DOM, fetch | ⚠️ Need JSDOM + mock fetch |
| `streaming.ts` | 345 | ❌ No | DOM, fetch, state, 4 modules | ❌ Hard - orchestrator |
| `session-panel.ts` | 250 | ❌ No | DOM, fetch, state | ❌ Hard - orchestrator |
| `model-selector.ts` | ~200 | ❌ No | DOM, fetch, state | ❌ Hard - orchestrator |
| `history.ts` | 70 | ❌ No | DOM, fetch | ⚠️ Need JSDOM + mock fetch |
| `main.ts` | ~100 | ❌ No | Everything | ❌ Integration only |

### Summary: What's Actually Testable Today

**Easy to unit test (pure logic):**
- `oembed.ts` - URL pattern matching, oEmbed parsing
- `output-cache.ts` - Store/retrieve/TTL
- `ui-utils.ts` - `escapeHtml`, `formatAge`
- `state.ts` (client) - State transitions

**That's about 450 lines out of ~2500 (18%).**

---

## Why 82% Is Hard to Test

The problem isn't TypeScript or web—it's architecture patterns:

### 1. Singletons with Hidden State

```typescript
// session-manager.ts - a singleton that owns everything
class SessionManager {
  private cwdLocks = new Map<string, string>();      // hidden state
  private activeSessions = new Map<...>();            // hidden state
  private sessionCache = new Map<...>();              // hidden state
  private stateDir = join(homedir(), '.copilot/..'); // hardcoded path
  
  async create(cwd: string, config: SessionConfig) {
    // Talks to SDK, file system, internal state
  }
}
export default new SessionManager();  // 👈 Singleton export
```

To test `create()`, you must:
- Have `~/.copilot/session-state/` exist
- Have SDK credentials configured
- Accept that previous tests pollute state

### 2. Functions That Do Too Much

```typescript
// streaming.ts - one function that orchestrates everything
export function streamResponse(prompt, model, imageData, cwd) {
  const eventSource = new EventSource(...);  // network
  setStreaming(true, eventSource);           // global state
  
  eventSource.addEventListener('assistant.message_delta', (e) => {
    responseContent += data.deltaContent;
    responseDiv.textContent = responseContent;  // DOM
    scrollToBottom();                           // more DOM
  });
  
  eventSource.addEventListener('tool.execution_complete', (e) => {
    renderDisplayOutput(data.output);           // async fetch + DOM
  });
  // ... 15 more event handlers mixing parsing + DOM + state
}
```

This function has ~8 responsibilities. To test any one, you must mock all 8.

### 3. DOM Coupling Everywhere

```typescript
// activity.ts - business logic mixed with DOM
export function addActivityItem(type, text, details) {
  const activityBox = document.querySelector('#pending-response .activity-box');
  if (!activityBox) return;
  
  const item = document.createElement('div');
  item.className = `activity-item ${type}`;
  // ... build DOM
  activityBox.appendChild(item);
  activityBox.scrollTop = activityBox.scrollHeight;
}
```

The logic "add an activity item with type/text/details" is simple. But it's welded to the DOM.

---

## Refactoring Strategy: Extract Pure Cores

Your C# instinct is right: **scoped behavior classes**. We need to extract pure logic from I/O wrappers.

### Pattern: Extract → Wrap → Inject

**Before (untestable):**
```typescript
class SessionManager {
  private stateDir = join(homedir(), '.copilot/...');
  
  private _discoverSessions() {
    for (const sessionId of readdirSync(this.stateDir)) {
      const yaml = parseYaml(readFileSync(...));
      this.sessionCache.set(sessionId, { cwd: yaml.cwd, summary: yaml.summary });
    }
  }
}
```

**After (testable):**
```typescript
// Pure logic - easy to test
interface SessionRecord { cwd: string | null; summary: string | null; }

export function parseSessionDir(eventsContent: string, workspaceYaml: string): SessionRecord {
  const firstLine = eventsContent.split('\n')[0];
  const event = JSON.parse(firstLine);
  const yaml = parseYaml(workspaceYaml);
  return {
    cwd: event.data?.context?.cwd ?? null,
    summary: yaml.summary ?? null
  };
}

// I/O wrapper - thin, hard to get wrong
class SessionStore {
  constructor(private stateDir: string) {}
  
  discoverAll(): Map<string, SessionRecord> {
    const cache = new Map();
    for (const sessionId of readdirSync(this.stateDir)) {
      const events = readFileSync(join(this.stateDir, sessionId, 'events.jsonl'), 'utf8');
      const yaml = readFileSync(join(this.stateDir, sessionId, 'workspace.yaml'), 'utf8');
      cache.set(sessionId, parseSessionDir(events, yaml));
    }
    return cache;
  }
}

// Manager becomes thin orchestrator
class SessionManager {
  constructor(private store: SessionStore) {}
  // ... delegates to store, pure logic in separate functions
}
```

Now you can test `parseSessionDir` with string inputs—no file system needed.

---

## Concrete Refactoring Targets

### Server-Side (high impact)

| Current | Extract | What It Enables |
|---------|---------|-----------------|
| `SessionManager._discoverSessions()` | `parseSessionDir(events, yaml)` | Test session parsing |
| `SessionManager.create/resume` | `SessionStore` interface | Mock persistence |
| `display-tools.ts` handlers | Pure formatters | Test output formatting |
| `preferences.ts` load/save | `PreferencesStore` interface | Mock file I/O |

### Client-Side (medium impact)

| Current | Extract | What It Enables |
|---------|---------|-----------------|
| `streaming.ts` event handlers | `parseStreamEvent(event)` | Test SSE parsing |
| `activity.ts` DOM building | `formatActivityItem(type, text)` → `{html, classes}` | Test formatting |
| `display-output.ts` render functions | `buildOutputHtml(data, metadata)` | Test output generation |

---

## Recommended Test Strategy

### Phase 1: Test What's Already Pure (Now)

```
tests/unit/
  oembed.test.ts        # URL detection, provider matching
  output-cache.test.ts  # Store/get/TTL
  ui-utils.test.ts      # escapeHtml, formatAge
  state.test.ts         # Client state transitions
```

~450 lines covered, immediate value, no refactoring needed.

### Phase 2: Extract and Test (Incremental)

For each feature we need to protect from regression:
1. Identify the pure logic hiding inside the I/O
2. Extract it to a pure function
3. Write tests for that function
4. Leave the I/O wrapper thin

### Phase 3: Integration Tests (Later)

Once unit coverage is solid:
- API route tests with supertest
- SSE streaming tests (mock SDK, real HTTP)

---

## Vitest Setup

```bash
npm install -D vitest @vitest/coverage-v8
```

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

## Example: Testing What's Pure Today

### `oembed.ts` - URL Detection

```typescript
import { describe, it, expect } from 'vitest';
import { detectProvider } from '../src/oembed.js';

describe('detectProvider', () => {
  it('detects YouTube watch URLs', () => {
    const result = detectProvider('https://youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result?.key).toBe('youtube');
  });
  
  it('detects YouTube short URLs', () => {
    const result = detectProvider('https://youtu.be/dQw4w9WgXcQ');
    expect(result?.key).toBe('youtube');
  });
  
  it('returns null for unknown URLs', () => {
    expect(detectProvider('https://example.com/video')).toBeNull();
  });
});
```

### `ui-utils.ts` - Pure Functions

```typescript
import { describe, it, expect } from 'vitest';
import { escapeHtml, formatAge } from '../public/ts/ui-utils.js';

describe('escapeHtml', () => {
  it('escapes HTML entities', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"quotes"')).toBe('&quot;quotes&quot;');
  });
});

describe('formatAge', () => {
  it('formats minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatAge(fiveMinAgo)).toBe('5 min');
  });
  
  it('formats hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(formatAge(twoHoursAgo)).toBe('2 hours');
  });
});
```

### `state.ts` - State Machine

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

// Note: We'd need to reset state between tests
// This reveals a design issue - singleton state is hard to test

describe('client state', () => {
  it('tracks session ID', () => {
    setActiveSession('sess-123', '/path');
    expect(getActiveSessionId()).toBe('sess-123');
    expect(getCurrentCwd()).toBe('/path');
  });
  
  it('tracks streaming state', () => {
    expect(isStreaming()).toBe(false);
    setStreaming(true, null);
    expect(isStreaming()).toBe(true);
  });
});
```

---

## Example: After Extracting Pure Logic

### Parsing Session Directory (extracted)

```typescript
// src/session-parser.ts (new file - pure logic)
export interface SessionRecord {
  cwd: string | null;
  summary: string | null;
}

export function parseSessionDir(eventsJsonl: string, workspaceYaml: string): SessionRecord {
  let cwd = null;
  let summary = null;
  
  // Parse events.jsonl first line
  const firstLine = eventsJsonl.split('\n')[0];
  if (firstLine) {
    try {
      const event = JSON.parse(firstLine);
      cwd = event.data?.context?.cwd ?? null;
    } catch { /* invalid JSON */ }
  }
  
  // Parse workspace.yaml
  try {
    const yaml = parseYaml(workspaceYaml);
    summary = yaml.summary ?? null;
  } catch { /* invalid YAML */ }
  
  return { cwd, summary };
}
```

```typescript
// tests/unit/session-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseSessionDir } from '../src/session-parser.js';

describe('parseSessionDir', () => {
  it('extracts cwd from events.jsonl', () => {
    const events = '{"type":"session.start","data":{"context":{"cwd":"/home/user/project"}}}';
    const yaml = 'summary: Test session';
    
    const result = parseSessionDir(events, yaml);
    expect(result.cwd).toBe('/home/user/project');
    expect(result.summary).toBe('Test session');
  });
  
  it('handles missing cwd gracefully', () => {
    const events = '{"type":"session.start","data":{}}';
    const yaml = '';
    
    const result = parseSessionDir(events, yaml);
    expect(result.cwd).toBeNull();
  });
  
  it('handles invalid JSON', () => {
    const events = 'not json';
    const yaml = 'summary: Still works';
    
    const result = parseSessionDir(events, yaml);
    expect(result.cwd).toBeNull();
    expect(result.summary).toBe('Still works');
  });
});
```

---

## When Tests Reveal Design Problems

You mentioned:
> "When you write tests, you may notice that the structure of our code is bad, the class is hard to test because it requires convoluted setup, or the test value is incomprehensible to the reader."

**Red flags I found in this codebase:**

1. **"I can't import SessionManager without it accessing the file system"**
   → Singleton initializes on import. Extract initialization.

2. **"To test addActivityItem, I need a full DOM with #pending-response .activity-box"**
   → DOM structure is implicit contract. Extract the data transformation.

3. **"streamResponse does 15 things, I can't test just the SSE parsing"**
   → Function is an orchestrator, not a behavior. Split it.

4. **"State tests pollute each other because state is module-level"**
   → Singleton state needs reset mechanism or factory pattern.

---

## Summary: Current Testability

| Category | Lines | % of Codebase | Effort to Test |
|----------|-------|---------------|----------------|
| Pure, testable now | ~450 | 18% | ✅ Easy |
| Needs JSDOM/mocks | ~400 | 16% | ⚠️ Medium |
| Needs refactoring | ~1650 | 66% | ❌ Hard |

**Recommendation:** Start with the 18% that's easy. As you add tests, extract pure logic from the 66% incrementally. Each extraction makes the next one easier.

The friction you feel writing tests **is the point**—it reveals where the architecture needs work.
