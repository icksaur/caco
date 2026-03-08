# Roadmap Applet

## Problem

Long-lived sessions (multi-day projects) lose track of next steps. The user has a mental roadmap but it's not visible in Caco. When resuming a session after hours or days, context is lost. The agent has plan.md but the user needs a persistent, visual overview that updates as work progresses.

## Design

A roadmap is a JSON structure stored as session metadata. It has a title, relevant documents, and an ordered list of steps. An applet renders it and reacts to session activity. A tool lets the agent update it without directly editing JSON.

### Data Model

```json
{
  "title": "Mesh solver rewrite",
  "documents": [
    "/home/carl/repo/mesh/doc/solver-spec.md",
    "/home/carl/repo/mesh/doc/performance.md"
  ],
  "steps": [
    {
      "title": "Implement Gauss-Seidel smoother",
      "description": "Replace Jacobi with red-black GS for 2x convergence",
      "status": "done",
      "context": ["src/solver/smoother.cpp", "tests/smoother_test.cpp"]
    },
    {
      "title": "Add multigrid V-cycle",
      "description": "3-level V-cycle with restriction/prolongation operators",
      "status": "active",
      "context": ["src/solver/multigrid.cpp", "doc/multigrid-design.md"]
    },
    {
      "title": "Benchmark against reference solver",
      "description": "Compare convergence rate and wall time on 256³ grid",
      "status": "pending",
      "context": ["tests/bench/solver_bench.cpp"]
    }
  ]
}
```

Step statuses: `pending` → `active` → `done` (or `blocked`).

### Storage

Store as `roadmap.json` in the session's Caco storage directory (`~/.caco/sessions/<id>/roadmap.json`). Not in `SessionMeta.context` — that's string arrays, and roadmap data is structured. A dedicated file is simpler and avoids schema changes.

### Server API

**`GET /api/sessions/:id/roadmap`** — returns the roadmap JSON, or `{ }` if none exists.

**`PATCH /api/sessions/:id/roadmap`** — merges updates. Accepts any subset:
```json
{ "title": "New title" }
{ "steps": [...] }
{ "documents": [...] }
```

### Agent Tool

**`update_roadmap`** — structured tool the agent calls to modify the roadmap without editing JSON directly.

Parameters:
- `action`: `set_title` | `add_step` | `update_step` | `remove_step` | `add_document` | `remove_document` | `reorder_steps`
- `title`: string (for `set_title`)
- `step`: `{ title, description?, status?, context? }` (for `add_step`, `update_step`)
- `stepIndex`: number (for `update_step`, `remove_step`)
- `document`: string path (for `add_document`, `remove_document`)
- `order`: number[] (for `reorder_steps` — new index order)

The tool reads the current roadmap, applies the action, writes back. Returns the updated roadmap. This avoids agents producing malformed JSON.

**`get_roadmap`** — reads the current session's roadmap and returns it. Essential for context recovery after compaction — the roadmap persists on disk but conversation history is lost. Agents should call this early in resumed/compacted sessions to understand what's done and what's next.

Returns the full roadmap JSON, or a message indicating no roadmap exists.

### Applet

**`?applet=roadmap`** — renders the active session's roadmap.

**Layout:**
- Title at top (editable on click)
- Document links — clickable, open in markdown-viewer or text-editor
- Step list — ordered, each step shows status icon, title, description, context links
- Status icons: ○ pending, ◐ active, ● done, ⊘ blocked

**Reactivity:**
- `onSessionChange` — reload roadmap when user switches sessions
- `onSessionEvent` — watch for `session.idle` → re-fetch roadmap (agent may have updated it)
- `onGlobalEvent` — watch `session.busy` for other sessions (future: multi-session dashboard)

**Interactions:**
- Click step status to cycle: pending → active → done → pending (PATCH via API)
- Click document link → open in appropriate viewer
- Click context link → open file
- Drag to reorder steps (stretch goal)

### Event Flow

```
Agent completes task
  → calls update_roadmap tool (status: done, next step: active)
  → tool writes roadmap.json
  → session.idle event fires
  → applet sees session.idle via onSessionEvent
  → applet re-fetches GET /api/sessions/:id/roadmap
  → UI updates with new step statuses
```

User switches session:
```
  → onSessionChange fires with sessionId + metadata
  → applet fetches roadmap for new session
  → renders new session's roadmap (or empty state)
```

## Considerations

- **Agent adoption:** Both tools must be in the system prompt. Include "call get_roadmap after compaction or session resume to recover context" and "call update_roadmap after completing major tasks" in session instructions.
- **Compaction recovery:** The roadmap is the primary context recovery mechanism. After compaction strips conversation history, the agent calls `get_roadmap` to see the full project state — what's done, what's active, what's next. This makes long-lived sessions viable across multiple compaction cycles.
- **No roadmap yet:** Applet shows an empty state with a "Create roadmap" prompt. Agent can create via tool, or user can click to create a blank one.
- **Multiple sessions, same project:** Different sessions for the same project will have separate roadmaps. This is intentional — each session's roadmap tracks its own work stream. A shared project roadmap across sessions is a future extension.
- **Roadmap size:** Keep it small. 5-20 steps max. The applet is a quick-glance overview, not a full project management tool.
- **Document paths vs content:** Documents are referenced by path, not inlined. The applet renders clickable links. The agent reads documents via its own tools when needed.

## Implementation Order

1. Server: `GET/PATCH /api/sessions/:id/roadmap` + storage in `~/.caco/sessions/<id>/roadmap.json`
2. Tool: `update_roadmap` with structured actions
3. Applet: roadmap renderer with session reactivity
4. System prompt: instruct agents to maintain roadmap
