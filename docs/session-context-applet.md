# Session Context Applet

## Goal

Evolve the roadmap applet into a unified **session context** applet that shows all persistent session state in one panel. Backwards compatible with existing roadmap data. Clean, consistent CSS with vertically stacked sections.

## Problem

The roadmap applet shows only roadmap steps and notes. Useful session state is scattered:
- Edited files are in the context footer (max 3, no links from applet)
- Intent history is lost (only current intent visible in session list)
- No single place to see "what this session has been doing"

## Slug and naming

- Applet slug: `session-context`
- Applet name: "Session Context"
- Footer link text: "context dashboard"
- Alias: `roadmap` → `session-context` (backwards compat for old links in chat history)

## Sections (top to bottom)

Empty sections are hidden. Sections appear as data arrives via WS events.

1. **Edited files** — auto-populated from `meta.context.files`. Real-time updates via `caco.context` WS event. Each file links to the appropriate viewer based on extension. Cap raised from 3 to 10 in `autoAddFileContext()`. Footer continues showing MRU 3.

2. **Roadmap** — existing roadmap section (title, documents, steps with status cycling). Unchanged behavior.

3. **Activity** — last 5 session intents from `meta.intentHistory[]`. Timestamped, no interactivity. Refreshes on `session.idle`. Uses existing absolute timestamp format (time-only for today, date+time for older).

4. **Notes** — session notes from `session_note` tool. Timestamped entries with archive (⌸) action. Same data as today.

5. **Presentation link** — if presentation exists, show link (existing behavior from roadmap applet).

## File viewer routing

Extract `getViewer(path)` to a shared utility function in the applet. Add image extension support:

| Extensions | Applet |
|-----------|--------|
| `md`, `mdx`, `markdown` | `markdown-viewer` |
| `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`, `ico` | `image-viewer` |
| everything else | `text-editor` |

## Data model changes

### Intent history (new field in SessionMeta)

```typescript
interface SessionMeta {
  // ... existing fields ...
  intentHistory?: Array<{ text: string; ts: number }>;
}
```

Modify `setSessionIntent()` in `src/storage.ts`:
- Append `{ text: intent, ts: Date.now() }` to `intentHistory`
- Cap at 5 entries (FIFO)
- Continue setting `currentIntent` as before

### Edited files cap change

`autoAddFileContext()` in `src/routes/session-messages.ts`: raise `MAX_CONTEXT_FILES` from 3 to 10. The context footer in `public/ts/context-footer.ts` continues displaying only the last 3 (slice from end).

## API changes

### Modified: `GET /api/sessions/:id/roadmap`

Add `contextFiles` and `intentHistory` to the response (from session metadata). Additive — existing fields unchanged.

```json
{
  "title": "My Roadmap",
  "steps": [...],
  "documents": [...],
  "contextFiles": ["src/main.ts", "src/app.ts"],
  "intentHistory": [
    { "text": "Fixing context footer bugs", "ts": 1714600000000 }
  ]
}
```

### No new endpoints

All data from existing sources: `roadmap.json`, `notes.json`, `meta.json`.

## Implementation

### Phase 1: Data changes

- `src/storage.ts`: Modify `setSessionIntent()` to append to `intentHistory` (capped at 5)
- `src/routes/session-messages.ts`: Raise `MAX_CONTEXT_FILES` to 10
- `public/ts/context-footer.ts`: Slice `context.files` to last 3 for footer display (if more than 3 arrive)
- `src/routes/sessions.ts`: Roadmap endpoint adds `contextFiles` and `intentHistory` from session meta

### Phase 2: Applet rename + alias

- `git mv applets/roadmap applets/session-context`
- Update `meta.json`: slug → `session-context`, name → `Session Context`
- Add alias in applet loader: `resolveAppletDir()` maps `roadmap` → `session-context` via a `SLUG_ALIASES` map
- Update `context-footer.ts`: roadmap link → `/?applet=session-context`, text → "context dashboard"
- Update any tool descriptions referencing `/?applet=roadmap`
- Update `stateSchema` in meta.json to reflect new applet scope

### Phase 3: Applet UI rewrite

Full rewrite of content.html, script.js, style.css in `applets/session-context/`.

**Sections rendered:**
- Files: `getViewer(path)` for links, real-time `caco.context` updates
- Roadmap: title, docs, steps with status cycling (port existing logic)
- Activity: `intentHistory` rendered as timestamped list
- Notes: timestamped entries with archive (port existing logic)
- Presentation: link if presentation data exists (port existing `checkPresentation()`)

**CSS:** Consistent `.sc-section` pattern — uniform heading style, padding, separator between sections. Theme-aware using CSS variables.

**Real-time:** `onSessionEvent` listens for `session.idle` and `tool.execution_complete` to refresh all sections. `caco.context` event updates file list immediately.

### Phase 4: Build, test, acceptance

- `npx tsc --noEmit`, `npm run build:client`, `npm test`
- Restart server
- Manual: applet loads at `/?applet=session-context` and `/?applet=roadmap` (alias)
- Footer link says "context dashboard" and opens correctly
- Files section shows edited files with correct viewer links
- Roadmap section unchanged behavior
- Activity section shows intent history
- Notes section unchanged behavior

## Risks

1. **Slug rename** — alias prevents 404 for old `/?applet=roadmap` links in chat history
2. **Intent history metadata growth** — capped at 5 entries, ~200 bytes. Negligible.
3. **Roadmap endpoint additive** — new fields ignored by old applet versions
4. **Files cap raised to 10** — more metadata written per edit, negligible disk impact
5. **CSS rewrite** — visual change. Test on dark themes.

## Code analysis

### Files to modify
- `applets/roadmap/` → `applets/session-context/` (rename + full rewrite)
- `src/storage.ts` — `setSessionIntent()` appends to `intentHistory`
- `src/routes/sessions.ts` — roadmap endpoint adds `contextFiles`, `intentHistory`
- `src/routes/session-messages.ts` — raise `MAX_CONTEXT_FILES` to 10
- `public/ts/context-footer.ts` — footer link text + URL, slice files to 3 for display
- Applet loader (applet resolution) — add slug alias `roadmap` → `session-context`

### Files unchanged
- `src/roadmap-tool.ts` — tools read/write `roadmap.json`, unchanged
- `notes.json` / `roadmap.json` — data files unchanged
- `src/routes/session-messages.ts` — context broadcasting logic unchanged (only cap changes)
