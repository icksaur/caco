# Unit Testing: copilot-web

## Current Status

| Module | Tests | Status |
|--------|-------|--------|
| `src/oembed.ts` | 21 | ✅ Covered |
| `src/output-cache.ts` | 49 | ✅ Covered |
| `public/ts/ui-utils.ts` | 29 | ✅ Covered |
| `public/ts/state.ts` | 26 | ✅ Covered |
| `public/ts/activity.ts` | 31 | ✅ Covered |
| `public/ts/sse-parser.ts` | 22 | ✅ Covered |
| **Total** | **178** | **25% of codebase** |

## Refactoring Plan: Extract Pure Logic

The remaining 82% is hard to test because logic is mixed with I/O.
Extract pure functions, then test those.

### Phase 1: Session Parsing (server)

| Step | Status | Description |
|------|--------|-------------|
| 1.1 | ⬜ | Extract `parseSessionRecord(eventsJsonl, workspaceYaml)` from `session-manager.ts` |
| 1.2 | ⬜ | Write tests for session parsing edge cases |
| 1.3 | ⬜ | Extract `SessionStore` interface for file I/O |

### Phase 2: Activity Formatting (client)

| Step | Status | Description |
|------|--------|-------------|
| 2.1 | ✅ | Add tests for `formatToolArgs(args)` - already pure |
| 2.2 | ✅ | Add tests for `formatToolResult(result)` - already pure |

### Phase 3: Stream Event Parsing (client)

| Step | Status | Description |
|------|--------|-------------|
| 3.1 | ✅ | Extract `parseSSEBuffer(buffer)` from `streaming.ts` |
| 3.2 | ✅ | Write tests for SSE parsing edge cases |

### Phase 4: Display Output Building (client)

| Step | Status | Description |
|------|--------|-------------|
| 4.1 | ⬜ | Extract `buildOutputHtml(data, metadata)` from `display-output.ts` |
| 4.2 | ⬜ | Write tests for each output type (embed, image, terminal, code) |

---

## Running Tests

```bash
npm test              # Run once (in build)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## Test Structure

```
tests/unit/
  oembed.test.ts        # URL detection, provider matching
  output-cache.test.ts  # Store/get/TTL, language detection
  ui-utils.test.ts      # escapeHtml, formatAge
  state.test.ts         # Client state management
  activity.test.ts      # (Phase 2) Tool formatting
```
