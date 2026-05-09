# UI Session Interaction

## Goal

Reduce reliance on typing for common session interactions. Two features that let users interact with sessions through clicks and pre-built prompts.

## Feature 1: Response Options (agent-offered prompts)

### Concept

When a session reaches a decision point, the agent calls a tool that presents clickable prompt buttons above the chat input. The user clicks one to send that prompt. This replaces the pattern of "Type 'yes' to continue" or "Choose option A or B."

### UX

Buttons appear in a horizontal row above the chat input bar (same area as image paste preview and swarm status). Clicking a button sends the prompt text and removes all buttons. Max 4 options.

If the user starts typing in the text input, the buttons grey out (muted opacity). Clearing the input restores them. If the user sends typed text, the buttons are removed — the agent's offered options are superseded by the user's own input.

### Durability

The option list must survive session resume. Stored in session metadata (`meta.json` field `responseOptions?: string[]`). On resume, if the session is idle and has `responseOptions`, the buttons reappear. When the user sends any message (clicked or typed), the field is cleared.

### Tool: `caco_offer_options`

```typescript
Parameters:
  options: string[];  // 1-4 short prompts (≤50 chars each)
```

Each option is both the button label and the exact prompt sent when clicked. No separate label/prompt — what you see is what gets sent. No interpretation gap, no surprise.

The tool is called at the end of a response when the agent identifies discrete next steps. The tool stores the options in session metadata and returns a signal to the frontend to render buttons.

### Tool description guidance

The tool description must clearly explain when to use it. Critical wording for Sonnet-level comprehension:

> Call this when your response ends with a clear set of discrete next actions the user can choose from. Good uses: approval gates ("Proceed" / "Modify first"), binary choices ("Yes" / "No"), workflow steps ("Run tests" / "Deploy" / "Skip"). Do not use for open-ended questions where the user needs to provide novel information. Max 4 options. Each option is both the button label and the exact text sent — keep them brief and unambiguous.

### Implementation

**Backend:**
- `src/offer-options-tool.ts` — tool definition, writes to `meta.responseOptions`
- Broadcast a `caco.options` event via WebSocket so the frontend renders immediately

**Frontend:**
- `public/ts/` — render option buttons above input bar on `caco.options` event
- On session resume: check `meta.responseOptions`, render if present and session idle
- On button click: send the prompt via normal message path, clear options from meta
- On text input: add `.muted` class to buttons. On input clear: remove `.muted`
- On any message send (typed or clicked): remove buttons + clear meta field

### Corner cases

- Agent calls tool mid-stream (not at end): buttons appear but session is busy, so they're disabled until idle
- Session switches while buttons visible: buttons are per-session, tied to `footerSessionId`
- Steer while options visible: steer sends, options remain (steer doesn't clear them — it's mid-turn guidance, not a response to the options)
- Agent calls tool twice in one turn: second call replaces first

## Feature 2: New-Session Custom Prompts

### Concept

Pre-built prompt templates displayed in the new-session view. Users click to fill the chat input, optionally edit, then send. Templates can contain variable placeholders that must be filled before sending.

### Source

Markdown files in `~/.caco/prompts/` (already exists — currently loaded as slash commands via `/api/prompts`). Each `.md` file is one prompt template. The first line is the description, the rest is the prompt content.

### UX

Below the model selector in the new-chat view, a colored list of prompt templates. Each shows the prompt name and first-line description. Clicking one fills the textarea with the prompt content.

### Variable placeholders

Prompts can contain `{{variable_name}}` placeholders. These render in a distinct color (theme-dependent accent). The Send button is disabled while any `{{...}}` pattern remains in the textarea. The user replaces them with actual values, then sends.

Example prompt file (`~/.caco/prompts/review-pr.md`):
```
Review a pull request for issues
Review {{pull-request-uri}} for code quality, bugs, and performance concerns.
```

Clicking fills textarea with:
```
Review the latest changes in {{repository_path}} for:
- Code quality issues
...
```

The `{{repository_path}}` and `{{specific_area}}` render highlighted. Send is blocked until both are replaced.

### Visual design

- Prompt cards with subtle hue-tinted backgrounds (cycle through theme-derived hues for visual variety)
- Compact: name + description in one line per prompt
- Cards appear only in new-chat view, hidden when a session is active
- Maximum display: 8 prompts (scroll if more exist)

### Implementation

**Backend:** Already exists — `GET /api/prompts` returns `{ prompts: [{ name, description }] }`, `GET /api/prompts/:name` returns `{ content }`. No backend changes needed.

**Frontend:**
- `public/ts/model-selector.ts` or new `prompt-cards.ts`: fetch prompts on new-chat view, render cards below model selector
- On card click: fetch prompt content, fill textarea, trigger input event (for auto-resize)
- Placeholder detection: regex `/\{\{[^}]+\}\}/` on textarea content
- Send guard: if placeholder pattern found, disable send button and show tooltip "Fill in highlighted placeholders"
- Placeholder highlighting: either CSS (if textarea supports it — unlikely) or an overlay approach. Simpler: just disable Send and let the placeholder text be visually obvious in the monospace textarea.

## Resolved Questions

1. No keyboard shortcuts for response option buttons.
2. No categories for prompts. Static order (filesystem order) is fine.
3. Regex for placeholder validation (`/\{\{[^}]+\}\}/`). Evaluated once when prompt is inserted into textarea. If user breaks the pattern and re-enters it, the validation is not re-evaluated — Send stays enabled. This is intentional for performance and is sufficient behavior.

---

## Additional Ideas (brainstorm, light spec)

### Idea 3: Pinned Actions

**Problem:** Users repeat the same prompts across sessions — "commit and push", "run tests", "build". These aren't templates (no variables), they're one-click shortcuts.

**Concept:** A small toolbar of user-defined action buttons, visible during active sessions. Stored as simple JSON in `~/.caco/actions.json`:

```json
[
  { "label": "🧪 Test", "prompt": "Run the tests and report results." },
  { "label": "📦 Build", "prompt": "Build the project." },
  { "label": "🔄 C+P", "prompt": "Commit and push." }
]
```

**UI:** 3-5 small pill buttons in the input bar area (next to the send button). Click sends immediately. Editable via the JSON file or a `/pin` slash command.

**Why it works:** Zero screen real estate when empty. Tiny when populated. User-defined, transparent config. No agent involvement in creating them — purely user-authored shortcuts.

**Tension with response options:** Pinned actions are always visible; response options are contextual. They share the same input bar area. Need clear visual separation.

### Idea 4: Session Bookmarks (resume-to-point)

**Problem:** Long sessions have important moments buried in scrollback. "Where was that architecture decision?" or "Go back to when we discussed the API design."

**Concept:** Agent or user can bookmark a point in the conversation with a label. Bookmarks appear in the session-context applet. Clicking one scrolls chat to that point.

**Tool:** `caco_bookmark` — stores a label + event ID. Lightweight — just an anchor into existing history.

**UI:** A small list in the session-context applet under roadmap. Click scrolls to the bookmarked message. No screen real estate cost in the main chat view.

**Why it works:** Uses existing infrastructure (session-context applet, event IDs). Agent can bookmark decision points automatically. User can bookmark manually via slash command. Transparent — bookmarks are visible in the applet and stored in session metadata.

### Idea 5: Contextual File Actions

**Problem:** The agent frequently edits files, and the user wants to quickly open, diff, or revert them. Currently requires typing "show me the diff" or navigating to the file-finder.

**Concept:** When `caco.context` event fires with edited files, each file in the context footer becomes a dropdown (click = open in editor, long-press/right-click = menu with: "Open", "Diff", "Gallery" for image dirs). No new UI surface — enhances the existing footer file links.

**Why it works:** Zero new screen real estate. Enhances existing UI. Files are already displayed. Adding a second action (diff) per file is high-value, low-cost.

### Idea 6: Agent-Authored Applets as Interaction

**Problem:** Complex interactions (forms, configuration wizards, data tables) don't fit chat or buttons. Applets can do this but are currently static.

**Concept:** Already exists in embryonic form — `caco_applet_howto` and `set_applet_state`/`get_applet_state` allow agents to create and communicate with applets. The missing piece is **discoverability** — agents don't proactively create applets for interactions that would benefit from them.

**Enhancement:** Add to the `caco_offer_options` tool a variant that offers an applet link as one of the options: `{ label: "Configure", applet: "/?applet=custom-form&..." }`. This bridges chat-based options with rich applet UI when a form or visual interaction is needed.

**Why it works:** Leverages existing applet infrastructure. No new UI surface. Agent decides when a custom UI is warranted. Transparent — the applet is inspectable code.

### Design principles for all interaction features

1. **Zero cost when unused** — no UI until activated. Empty state is invisible.
2. **Transparent config** — JSON/markdown files, slash commands, visible metadata. User can always see why something appears and edit/remove it.
3. **No monolithic applet** — each feature lives in its natural home (input bar, footer, session-context applet). Screen real estate is borrowed, not claimed.
4. **Agent-friendly but user-controlled** — agents can suggest/create (response options, bookmarks), users can define (pinned actions, custom prompts). Neither side owns all interactions.
