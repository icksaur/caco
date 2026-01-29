# Unit Testing: Caco

## Current Status

| Module | Tests | Status |
|--------|-------|--------|
| `src/oembed.ts` | 21 | ✅ Covered |
| `src/output-cache.ts` | 6 | ✅ Covered |
| `src/image-utils.ts` | 14 | ✅ Covered |
| `src/session-parsing.ts` | 20 | ✅ Covered |
| `public/ts/ui-utils.ts` | 6 | ✅ Covered |
| `public/ts/state.ts` | 6 | ✅ Covered |
| `public/ts/activity.ts` | 9 | ✅ Covered |
| `public/ts/sse-parser.ts` | 22 | ✅ Covered |
| `public/ts/markdown-builders.ts` | 6 | ✅ Covered |
| **Total** | **110** | **Focused regression tests** |

## Refactoring Plan: Extract Pure Logic

The remaining 82% is hard to test because logic is mixed with I/O.
Extract pure functions, then test those.

### Phase 1: Session Parsing (server)

| Step | Status | Description |
|------|--------|-------------|
| 1.1 | ✅ | Extract `parseSessionStartEvent()` and `parseWorkspaceYaml()` from `session-manager.ts` |
| 1.2 | ✅ | Write tests for session parsing edge cases (25 tests) |
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
| 4.1 | ✅ | Extract `buildTerminalMarkdown()` and `buildCodeMarkdown()` from `display-output.ts` |
| 4.2 | ✅ | Write tests for each output type (22 tests) |

### Phase 5: Image Handling

| Step | Status | Description |
|------|--------|-------------|
| 5.1 | ✅ | Extract `parseImageDataUrl()` for base64 image parsing |
| 5.2 | ✅ | Write tests for image data URL parsing (14 tests) |

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
  activity.test.ts        # Tool formatting
  image-utils.test.ts     # Image data URL parsing
  markdown-builders.test.ts # Terminal/code markdown building
  oembed.test.ts          # URL detection, provider matching
  output-cache.test.ts    # Store/get/TTL, language detection
  session-parsing.test.ts # Session start/workspace.yaml parsing
  sse-parser.test.ts      # SSE buffer parsing
  state.test.ts           # Client state management
  ui-utils.test.ts        # escapeHtml, formatAge
```
