# Backend Code Review

**Date**: February 1, 2026  
**Reviewer**: New contributor perspective  
**Scope**: All backend code (`server.ts`, `src/`)  
**Standards**: See [code-quality.md](code-quality.md)

---

## Executive Summary

This codebase has **reasonable architecture** with clear separation of concerns, but suffers from **significant coupling issues**, **inconsistent patterns**, and **complexity hotspots** that will make feature development and debugging painful.

**Overall Grade: C+**

The good: Well-organized directory structure, decent type coverage, pure utility functions.  
The bad: Tight coupling, global state, unclear ownership boundaries, inconsistent error handling.

---

## 🔴 CRITICAL ISSUES

### 1. God Objects: SessionManager and SessionState

**Files**: [src/session-manager.ts](src/session-manager.ts), [src/session-state.ts](src/session-state.ts)

`SessionManager` (621 lines) does **way too much**:
- SDK client lifecycle
- Session cache management
- Disk discovery
- Lock coordination
- Busy/idle tracking
- Model fetching
- History retrieval
- Agent correlation tracking

`SessionState` is a **singleton with global mutable state** that wraps `SessionManager` and adds:
- Multi-client session tracking
- Preference management
- Init/shutdown lifecycle

**Problem**: These two classes are tightly coupled, and almost every route depends on both. Adding any session-related feature requires understanding both.

**Fix**: Split `SessionManager` into:
- `SDKClientPool` - SDK lifecycle only
- `SessionCache` - Disk discovery and caching
- `SessionHistory` - History retrieval
- Move correlation tracking to a separate `CorrelationTracker`

---

### 2. Circular Import Risk: applet-tools → websocket

**File**: [src/applet-tools.ts#L8](src/applet-tools.ts)

```typescript
import { pushStateToApplet } from './routes/websocket.js';
```

A tool module imports from the routes layer. This creates:
- Tight coupling between business logic and transport
- Initialization order dependencies
- Testing difficulties

**Fix**: Inject a push function via the tool factory, or use an event emitter pattern.

---

### 3. Global State Everywhere

| Module | Global State | Issue |
|--------|--------------|-------|
| [session-state.ts](src/session-state.ts) | `sessionState` singleton | All routes depend on this |
| [applet-state.ts](src/applet-state.ts) | `appletUserState`, `appletNavigation`, `pendingReload` | Module-level mutables |
| [usage-state.ts](src/usage-state.ts) | `currentUsage` | Module-level mutable |
| [cwd-lock-manager.ts](src/cwd-lock-manager.ts) | `cwdLockManager` singleton | Module-level export |
| [session-manager.ts](src/session-manager.ts) | `sessionManager` default export | God object singleton |
| [restart-manager.ts](src/restart-manager.ts) | `restartRequested`, `activeDispatches`, `onAllIdleCallback` | Module-level mutables |
| [storage.ts](src/storage.ts) | `outputCache`, `cwdToSessionId` | Module-level Maps |
| [routes/api.ts](src/routes/api.ts) | `cachedModels`, `modelsCacheTime`, `programCwd` | Module-level mutables |
| [routes/websocket.ts](src/routes/websocket.ts) | `allConnections`, `sessionSubscribers`, `clientSubscription` | Module-level Sets/Maps |

**This is the #1 maintainability killer.** Debugging requires understanding which module mutated what state when.

**Fix**: Use dependency injection or a central state container that can be inspected/reset.

---

### 4. Hardcoded Magic Values

| Location | Value | Issue |
|----------|-------|-------|
| [session-messages.ts#L178](src/routes/session-messages.ts) | No timeout on `sendStream` | Stream can hang forever |
| [schedule-manager.ts#L11-12](src/schedule-manager.ts) | `30 * 60 * 1000`, `60 * 60 * 1000` | Magic numbers for intervals |
| [correlation-metrics.ts#L15-18](src/correlation-metrics.ts) | `maxDepth: 2`, `maxAgeSeconds: 60 * 60` | Should be configurable |
| [storage.ts#L13](src/storage.ts) | `30 * 60 * 1000` | Cache TTL buried in code |
| [restarter.ts#L14-15](src/restarter.ts) | `500`, `30000` | Poll/timeout constants |
| [api.ts#L33](src/routes/api.ts) | `5 * 60 * 1000` | Model cache TTL |

**Fix**: Move to `config.ts` or create a `constants.ts` with named exports.

---

### 5. Inconsistent Error Handling

Routes use at least 4 different error patterns:

```typescript
// Pattern 1: Status code in response
res.status(400).json({ error: 'path required' });

// Pattern 2: Code field
res.status(409).json({ error: message, code: 'CWD_LOCKED' });

// Pattern 3: Boolean ok field
res.json({ ok: false, error: message });

// Pattern 4: Plain text
res.status(403).send('Access denied: path outside workspace');
```

**Fix**: Standardize on a single error response format:
```typescript
{ ok: false, error: string, code?: string }
```

---

## 🟠 MAJOR ISSUES

### 6. Missing Type Safety in SDK Interactions

**File**: [src/session-manager.ts](src/session-manager.ts)

Extensive use of `as unknown as` casts:
```typescript
const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
```

The `CopilotClient` types are redefined locally rather than imported from the SDK, creating maintenance burden when the SDK updates.

**Fix**: Create a proper type wrapper or use `@types/` definitions.

---

### 7. Duplicate Code in Route Handlers

**Files**: [src/routes/api.ts](src/routes/api.ts)

Path validation logic is repeated 6+ times:
```typescript
const fullPath = resolve(programCwd, requestedPath);
const relativePath = relative(programCwd, fullPath);
if (relativePath.startsWith('..') || resolve(programCwd, relativePath) !== fullPath) {
  res.status(403).json({ error: 'Access denied: path outside workspace' });
  return;
}
```

**Fix**: Extract to `validatePath(base: string, requested: string): { valid: true, resolved: string } | { valid: false, error: string }`.

---

### 8. Legacy Endpoints Still Present

**File**: [src/routes/api.ts](src/routes/api.ts)

```typescript
/**
 * GET /api/files/read - Read file content (LEGACY - use GET /api/file instead)
 */

/**
 * POST /api/files/write - Write file content (LEGACY - use PUT /api/files/* instead)
 */
```

Legacy endpoints with no deprecation timeline or removal plan.

**Fix**: Add `X-Deprecated` headers, log usage, set removal date.

---

### 9. Timeout Handling is Fragile

**File**: [src/routes/session-messages.ts](src/routes/session-messages.ts)

The dispatch function has no timeout:
```typescript
sessionManager.sendStream(sessionId, prompt, messageOptions);
```

If the SDK stream never completes, the session stays "busy" forever, blocking future messages.

**Fix**: Add a watchdog timer that marks the session idle after a configurable timeout.

---

### 10. No Request Validation Middleware

Route handlers manually validate every field:
```typescript
if (!prompt) {
  res.status(400).json({ error: 'prompt is required' });
  return;
}
```

**Fix**: Use `zod` + middleware to validate request bodies before handlers run.

---

## 🟡 MODERATE ISSUES

### 11. Async/Sync File API Mixing

| Module | Uses |
|--------|------|
| [storage.ts](src/storage.ts) | `mkdirSync`, `writeFileSync`, `readFileSync` |
| [session-manager.ts](src/session-manager.ts) | `readFileSync`, `readdirSync`, `existsSync` |
| [usage-state.ts](src/usage-state.ts) | `readFileSync`, `writeFileSync`, `mkdirSync` |
| [preferences.ts](src/preferences.ts) | `readFile`, `writeFile` (async) |
| [schedule-store.ts](src/schedule-store.ts) | `mkdir`, `readFile`, `writeFile` (async) |

**Problem**: Sync calls block the event loop. Some modules use async, others sync for no clear reason.

**Fix**: Standardize on async everywhere except truly synchronous initialization.

---

### 12. Comments Explaining What, Not Why

**File**: [src/session-state.ts](src/session-state.ts)

```typescript
// Clear pending resume - user wants a fresh chat
this.setPendingResumeId(null, clientId);
```

The comment just restates the code. The *why* ("pending resume from auto-detect would conflict with explicit new chat request") is missing.

---

### 13. Oversized Functions

| Function | File | Lines | Issue |
|----------|------|-------|-------|
| `ensureSession` | session-state.ts | 80+ | Does resume, create, preference save |
| `dispatchMessage` | session-messages.ts | 90+ | Setup, stream, cleanup, error handling |
| `executeSchedule` | schedule-manager.ts | 80+ | Check, POST, create, error handling |

**Fix**: Extract smaller functions with single responsibilities.

---

### 14. Missing Tests for Core Modules

**Tested**:
- ✅ chain-stack.ts
- ✅ event-filter.ts
- ✅ image-utils.ts
- ✅ oembed.ts
- ✅ rules-engine.ts
- ✅ sdk-event-parser.ts
- ✅ session-parsing.ts
- ✅ storage.ts

**Not Tested**:
- ❌ session-manager.ts (the god object!)
- ❌ session-state.ts (the other god object!)
- ❌ schedule-manager.ts
- ❌ correlation-metrics.ts
- ❌ cwd-lock-manager.ts
- ❌ preferences.ts
- ❌ restart-manager.ts
- ❌ applet-tools.ts
- ❌ agent-tools.ts
- ❌ display-tools.ts

**Fix**: The untested modules are the most complex and critical. Prioritize them.

---

### 15. Inconsistent Logging

```typescript
console.log(`✓ Created session ${session.sessionId}`);  // Unicode checkmark
console.log(`[MODEL] Creating SDK session`);             // [TAG] format
console.log('[SCHEDULER] Starting schedule manager');    // Different tag
console.error('[UNHANDLED REJECTION]', reason);          // Error level
console.warn(`Warning: session.destroy() failed`);       // Plain warn
```

No structured logging. No log levels. No correlation IDs.

**Fix**: Use a proper logger (pino, winston) with structured output.

---

### 16. Unused Imports and Dead Code

**File**: [src/routes/websocket.ts#L3](src/routes/websocket.ts)
```typescript
import { randomUUID } from 'crypto';  // Never used
```

**File**: [src/applet-tools.ts](src/applet-tools.ts)
```typescript
// APPLET_HOWTO is a 100+ line string only returned by one tool
// Could be in a separate file or generated
```

**Fix**: Run `knip` (already in project) and fix findings.

---

### 17. Type Assertions Hide Bugs

**File**: [src/routes/sessions.ts#L86](src/routes/sessions.ts)
```typescript
(error as { sessionId?: string }).sessionId
```

This assumes the error has a `sessionId` property. If the SDK changes, this silently returns `undefined`.

**Fix**: Use type guards:
```typescript
if (error instanceof CwdLockedError) {
  return res.status(409).json({ sessionId: error.sessionId });
}
```

---

### 18. Missing Input Sanitization

**File**: [src/routes/mcp.ts](src/routes/mcp.ts)

Path is validated but not sanitized:
```typescript
const resolved = resolve(requestedPath);
return ALLOWED_BASES.some(base => resolved.startsWith(resolve(base)));
```

This could allow paths like `/tmp/../home/user/secrets` if `resolve` isn't called first on `requestedPath`.

Wait—it IS called on `requestedPath`. But the check `resolved.startsWith(resolve(base))` could still allow `/tmp` to match `/tmporary-files` (though unlikely).

**Fix**: Use `path.resolve()` + `path.normalize()` + strict prefix check with trailing separator.

---

## 🟢 GOOD PRACTICES FOUND

### ✓ Pure Functions Extracted

- [chain-stack.ts](src/chain-stack.ts) - Pure stack collapse algorithm
- [image-utils.ts](src/image-utils.ts) - Pure data URL parsing
- [session-parsing.ts](src/session-parsing.ts) - Pure YAML/JSON parsing
- [event-filter.ts](src/event-filter.ts) - Pure event filtering

### ✓ Clear Interface Types

[src/types.ts](src/types.ts) has well-defined interfaces for sessions, configs, and responses.

### ✓ Tool Factory Pattern

[server.ts#L34-48](server.ts) uses a factory to create session-scoped tools, keeping tools isolated per session.

### ✓ Separation of Transport and Logic

Routes mostly delegate to managers rather than containing business logic directly.

### ✓ Graceful Shutdown

[server.ts#L149-153](server.ts) handles SIGINT properly, stopping sessions before exit.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       server.ts                              │
│  • Express setup                                             │
│  • Route mounting                                            │
│  • Tool factory creation                                     │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
│ routes/      │   │ routes/      │   │ routes/              │
│ sessions.ts  │   │ api.ts       │   │ session-messages.ts  │
└──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘
       │                  │                       │
       │                  │                       │
       ▼                  ▼                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    session-state.ts                          │
│  • Active session tracking (per client)                      │
│  • Preference management                                     │
│  • Session lifecycle orchestration                           │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                    session-manager.ts                        │
│  • SDK client pool                                           │
│  • Session cache                                             │
│  • Disk discovery                                            │
│  • Lock management (via cwd-lock-manager)                    │
│  • Correlation tracking                                      │
└────────────────────────────┬─────────────────────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌────────────┐   ┌────────────┐   ┌────────────────┐
    │ storage.ts │   │ cwd-lock-  │   │ correlation-   │
    │            │   │ manager.ts │   │ metrics.ts     │
    └────────────┘   └────────────┘   └────────────────┘
```

**Coupling Problems Visualized**:
- `session-messages.ts` → `session-state.ts` → `session-manager.ts` (3-level chain)
- `applet-tools.ts` → `routes/websocket.ts` (tool→route dependency)
- Almost everything → singletons

---

## Recommendations Priority

### Must Fix (P0)
1. Split `SessionManager` into focused classes
2. Remove circular `applet-tools` → `websocket` dependency
3. Add timeout watchdog to message dispatch
4. Standardize error response format

### Should Fix (P1)
5. Replace module-level mutable state with injected dependencies
6. Add tests for session-manager and session-state
7. Extract path validation to a utility function
8. Standardize on async file APIs

### Nice to Have (P2)
9. Structured logging
10. Remove legacy endpoints
11. Move magic numbers to config
12. Request validation middleware

---

## Specific File Grades

| File | Grade | Notes |
|------|-------|-------|
| [server.ts](server.ts) | B | Clean entry point, some coupling |
| [src/types.ts](src/types.ts) | A- | Good types, could use more |
| [src/config.ts](src/config.ts) | B+ | Too minimal, should have more config |
| [src/session-manager.ts](src/session-manager.ts) | D | God object, untested |
| [src/session-state.ts](src/session-state.ts) | D+ | Global singleton, complex |
| [src/storage.ts](src/storage.ts) | C+ | Sync APIs, global Maps |
| [src/applet-state.ts](src/applet-state.ts) | C | Global mutables, simple enough |
| [src/applet-store.ts](src/applet-store.ts) | B | Clean, async, focused |
| [src/applet-tools.ts](src/applet-tools.ts) | C | Imports from routes layer |
| [src/agent-tools.ts](src/agent-tools.ts) | B | Clear, focused, uses config |
| [src/display-tools.ts](src/display-tools.ts) | B+ | Good injection pattern |
| [src/schedule-manager.ts](src/schedule-manager.ts) | C | Magic numbers, untested |
| [src/schedule-store.ts](src/schedule-store.ts) | B+ | Clean, async, focused |
| [src/cwd-lock-manager.ts](src/cwd-lock-manager.ts) | B | Focused, but singleton |
| [src/correlation-metrics.ts](src/correlation-metrics.ts) | B- | Good structure, untested |
| [src/chain-stack.ts](src/chain-stack.ts) | A | Pure, tested, documented |
| [src/rules-engine.ts](src/rules-engine.ts) | A- | Pure, tested |
| [src/rate-aggregator.ts](src/rate-aggregator.ts) | A | Pure, focused |
| [src/event-filter.ts](src/event-filter.ts) | A | Pure, tested |
| [src/sdk-event-parser.ts](src/sdk-event-parser.ts) | A- | Pure, tested |
| [src/session-parsing.ts](src/session-parsing.ts) | A | Pure, tested |
| [src/image-utils.ts](src/image-utils.ts) | A | Pure, tested |
| [src/oembed.ts](src/oembed.ts) | A- | Tested, could be more modular |
| [src/preferences.ts](src/preferences.ts) | C+ | Async, but swallows errors |
| [src/usage-state.ts](src/usage-state.ts) | C | Sync APIs, global state |
| [src/restart-manager.ts](src/restart-manager.ts) | C | Global state, untested |
| [src/restarter.ts](src/restarter.ts) | C+ | Standalone, magic numbers |
| [src/routes/index.ts](src/routes/index.ts) | A | Clean exports |
| [src/routes/sessions.ts](src/routes/sessions.ts) | B- | Clear but tightly coupled |
| [src/routes/api.ts](src/routes/api.ts) | C | Too big, duplicate code, legacy endpoints |
| [src/routes/session-messages.ts](src/routes/session-messages.ts) | C | Complex dispatch, no timeout |
| [src/routes/websocket.ts](src/routes/websocket.ts) | B- | Global state, but isolated |
| [src/routes/mcp.ts](src/routes/mcp.ts) | B | Simple, could extract validation |
| [src/routes/schedule.ts](src/routes/schedule.ts) | B | Clean REST API |

---

## Conclusion

This codebase works, but it's fragile. The core session management code is tightly coupled, globally stateful, and untested. A new contributor will spend significant time understanding the interaction between `SessionManager`, `SessionState`, and the various routes before they can safely make changes.

**Top 3 things to fix first:**
1. Add tests for `session-manager.ts` and `session-state.ts`
2. Split `SessionManager` into focused modules
3. Replace global singletons with dependency injection

The pure utility functions (`chain-stack`, `event-filter`, `image-utils`, etc.) are excellent examples of how the rest of the code should be structured.

---

*Review complete. Questions welcome.*
