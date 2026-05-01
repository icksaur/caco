# Presentation Applet — Implementation Plan

> Plan for [docs/presentation-applet.md](presentation-applet.md)

## Phase 1: Generic Session Data API

Foundation work that benefits all session data consumers, not just presentation.

### 1a. `listSessionData()` in storage.ts
- Add function that scans `~/.caco/sessions/<id>/` and returns JSON file names (excluding `meta.json`, `notes.json`)
- Export from `storage.ts`

### 1b. Path traversal fix + index route
- **Security fix:** Add `SAFE_NAME` regex (`/^[a-zA-Z0-9_-]+$/`) validation to the **existing** `GET/PUT /data/:name` routes (lines 474-489 of sessions.ts)
- Add new `GET /api/sessions/:id/data` index route returning `string[]`
- The GET/PUT by-name routes already exist — only add sanitization, not new routes

### 1c. Verify
- Manual test: `curl /api/sessions/<id>/data` returns `["roadmap"]` for a session with a roadmap
- Confirm `GET /data/../../etc` returns 400
- `GET /data/roadmap` returns same as `GET /roadmap`

## Phase 2: Presentation Storage + Types

### 2a. Types in storage.ts
- Add `Presentation` interface: `{ title: string; slides: string[] }`
- Add `getSessionPresentation()` / `setSessionPresentation()` typed helpers

### 2b. Verify
- Confirm `getSessionData(id, 'presentation')` round-trips correctly

## Phase 3: MCP Tools

### 3a. Create `src/presentation-tool.ts`
- `get_presentation` — read presentation for current or specified session
- `update_presentation` — title, slides (replace all), addSlide, addSlideIndex, updateSlideIndex, updateSlide, removeSlideIndex, removeAll
- `applyPresentationUpdate(existing, params)` — pure mutation function, exported for reuse by PATCH route
- Max 100 slides enforced in update
- Follow `roadmap-tool.ts` patterns: `SessionIdRef`, `defineTool`, zod schemas
- Motivating tool description per spec

### 3b. Write tests for mutation logic
- `tests/unit/presentation-tool.test.ts` — add, update, remove, removeAll, max slides, edge cases
- Test `applyPresentationUpdate` directly (pure function, no disk I/O)

### 3b. Register in server.ts
- Import `createPresentationTools` in tool factory
- Add alongside roadmap tools

### 3c. Verify
- Send a message asking agent to create a presentation
- Confirm `~/.caco/sessions/<id>/presentation.json` created
- Confirm `GET /api/sessions/<id>/data` now includes `"presentation"`

## Phase 4: REST Routes

### 4a. Typed presentation endpoints
- `GET /api/sessions/:id/presentation` — return presentation JSON or `{}`
- `PATCH /api/sessions/:id/presentation` — calls `applyPresentationUpdate` (shared with MCP tool)
- Add to `src/routes/sessions.ts`

### 4b. Verify
- `curl` GET/PATCH round-trip

## Phase 5: Applet

### 5a. Create `applets/presentation/`
- `meta.json` — slug, name, agentUsage, stateSchema
- `content.html` — title, slide container, nav bar
- `style.css` — 16:9 aspect ratio slide, theme variables, overflow hidden, nav bar
- `script.js` — session tracking, slide rendering via `renderMarkdownElement`, prev/next, keyboard arrows, initial load

### 5b. Key CSS decisions
- Root container: `height: 100%` (fills panel like git-diff)
- Slide: `aspect-ratio: 16/9`, `overflow: hidden`, centered in container
- Nav bar: fixed at bottom, prev/next buttons + slide counter
- All colors from CSS variables

### 5c. Verify
- Open applet in browser, confirm empty state
- Agent creates presentation, confirm slides render
- Navigate prev/next, confirm keyboard arrows work
- Expand panel (Escape+,), confirm slide fills space
- Switch sessions, confirm presentation changes

## Phase 6: Roadmap Link

### 6a. Modify roadmap applet
- Add `checkPresentation()` using `GET /api/sessions/<id>/data` index
- Show `📊 Presentation` link at top when presentation exists
- Call on session change and after tool execution

### 6b. Verify
- Session with presentation: roadmap shows link
- Session without: no link
- Click link opens presentation applet

## Phase 7: Final Verification

- Run full `npm run build` (lint, typecheck, knip, tests)
- Manual end-to-end: agent creates presentation → applet renders → roadmap shows link

## Stretch: Image Rewriting

- In applet `script.js`, post-process rendered HTML to rewrite `<img src="...">` to `/api/file?path=...`
- Resolve relative paths against session CWD
- Skip http/https URLs and existing `/api/` paths

## Files Changed

| File | Change |
|------|--------|
| `src/storage.ts` | `Presentation` interface, typed helpers, `listSessionData()` |
| `src/routes/sessions.ts` | Generic data routes, presentation GET/PATCH |
| `src/presentation-tool.ts` | **New** — MCP tools |
| `server.ts` | Register presentation tools in factory |
| `applets/presentation/` | **New** — 4 files |
| `applets/roadmap/script.js` | Add presentation link |
| `tests/unit/presentation-tool.test.ts` | **New** — tool tests |

## Not in Scope

- Presenter notes (speaker notes per slide)
- Slide transitions / animations
- Export to PDF/HTML
- Collaborative editing (multi-session)
- Slide templates or themes beyond Caco CSS variables
