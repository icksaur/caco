# Refactoring Plan: copilot-web

## Goals
1. **TypeScript migration** - Type safety, catch bugs at compile time
2. **Modular architecture** - Split large files into focused modules
3. **Consolidated state** - Single source of truth for session state
4. **Testability** - Structure code for unit testing

## Current State
- **Total**: ~2500 lines across 7 files
- **server.js**: 586 lines (routing + session management + streaming)
- **public/chat.js**: 968 lines (UI + state + streaming + everything)
- **src/session-manager.js**: 382 lines (OK, but could be cleaner)
- **src/display-tools.js**: 278 lines (OK)
- **src/oembed.js**: 119 lines (OK)
- **src/output-cache.js**: 81 lines (OK)
- **src/preferences.js**: 55 lines (OK)

## Phase 1: TypeScript Setup ✅
- [x] Install TypeScript and type dependencies
- [x] Create tsconfig.json
- [x] Update package.json scripts
- [x] Rename src/*.js → src/*.ts (server-side first)
- [x] Add types incrementally
- [x] Verify server still runs

## Phase 2: Server-Side Refactoring ✅
- [x] Create src/types.ts for shared types
- [x] Create src/session-state.ts (consolidate activeSessionId, preferences)
- [x] Create src/routes/sessions.ts
- [x] Create src/routes/stream.ts
- [x] Create src/routes/api.ts (history, preferences, output)
- [x] Slim down server.ts to just Express setup (~115 lines vs 586)
- [x] Verify all endpoints still work

## Phase 3: Client-Side Modularization ✅
- [x] Create public/ts/ directory structure
- [x] Split chat.js into modules:
  - [x] public/ts/types.ts - Type definitions
  - [x] public/ts/image-paste.ts - Image handling
  - [x] public/ts/session-panel.ts - Session UI
  - [x] public/ts/model-selector.ts - Model dropdown
  - [x] public/ts/streaming.ts - SSE handling
  - [x] public/ts/history.ts - History loading
  - [x] public/ts/ui-utils.ts - Scrolling, formatting
  - [x] public/ts/activity.ts - Activity box management
  - [x] public/ts/display-output.ts - Display output rendering
  - [x] public/ts/main.ts - Init and event binding
- [x] Set up esbuild for bundling
- [x] Update index.html to use bundled JS

## Phase 4: Session State Consolidation
- [ ] Create explicit SessionState class
- [ ] Single entry point for session creation
- [ ] Remove duplicate model/session tracking
- [ ] Add state machine for session lifecycle

## Phase 5: Testing Setup
- [ ] Install vitest or jest
- [ ] Create test directory structure
- [ ] Write unit tests for:
  - [ ] session-manager.ts
  - [ ] session-state.ts
  - [ ] oembed.ts
  - [ ] output-cache.ts
  - [ ] preferences.ts
- [ ] Add integration tests for key API endpoints
- [ ] Add test script to package.json

## Success Criteria
- All existing functionality works
- TypeScript compiles with no errors
- Server starts and handles requests
- UI works in browser
- Tests pass
- Code is organized into focused modules

## Progress Log
| Date | Phase | Status | Notes |
|------|-------|--------|-------|
| 2026-01-25 | Start | Planning | Created this document |
| 2026-01-25 | Phase 1 | Complete | TypeScript migration done, server works |
| 2026-01-25 | Phase 2 | Complete | Server split into routes, SessionState class |
| 2026-01-25 | Phase 3 | Complete | Client-side TS modules, esbuild bundle |

---

## Rollback Plan
Each phase will be committed separately. If issues arise:
```bash
git revert HEAD  # Undo last phase
```

## Notes
- Keep changes incremental
- Test after each file conversion
- Preserve all existing behavior
