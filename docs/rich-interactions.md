# Rich Interactions: Beyond Chat for Agentic Sessions

## Premise

Caco is an agentic development harness with three layers:

- **Foundations** (session management, chat UI, slash/pound)
- **Power features** (orchestration, scheduling, self-modification, browser-as-portal)
- **Interaction layer** (still mostly text)

The interaction layer is the gap. Chat is universal but lossy: it forces every input through a single channel (a textarea) and every output through a single channel (a scrolling document). When the user has discrete choices, structured selections, spatial relationships, or live state to convey, chat is the wrong shape.

This paper synthesizes four research angles — academic HCI, shipping AI products, web UI patterns, and Caco-specific opportunities — and proposes a thesis for what Caco's interaction layer should become.

## Thesis

> The user's job is to **point**, **select**, **arrange**, and **approve**. The agent's job is to **structure**, **render**, and **propose**. Each side does what they're best at; the interaction surface is where they meet.

Free-text input is a fallback, not the primary channel. The primary channel is whichever surface naturally encodes the user's intent: a checkbox over a directory tree, a click on a diff hunk, a sticky note dragged into a cluster, a slider moving from 0.5 to 0.7.

## Five high-leverage findings

### 1. Direct manipulation already encodes typed instructions

**(Source: web UI patterns research)**

Every click in a web UI carries information that prose can't easily express:

- **Selection defines scope.** Multi-selecting cells in a grid says "these specifically" without naming them.
- **Drag expresses propagation.** Dragging a card from "Now" to "Later" is a re-priorit­ization directive.
- **Spatial arrangement carries semantics.** Sticky notes clustered on a whiteboard ARE a taxonomy.
- **Annotation threads are distributed specs.** Eighteen inline comments on a doc form a structured change request.

The mistake is treating these as decoration on top of a chat. They ARE the input language.

**Implication for Caco:** When the agent produces a list of files, those files should be selectable. When the agent proposes 5 hypotheses, those hypotheses should be clickable. When the agent shows a diff, the user should reject hunks, not type "skip the third one."

### 2. Phase-aligned collaboration

**(Source: HCI research)**

The same user wants different amounts of help at different phases:

| Phase | User wants | Agent should |
|-------|-----------|---------------|
| Ideation | Maximum agency | Stay quiet; provide ghost suggestions only |
| Drafting | Co-author | Propose continuations, accept fast |
| Reviewing | Critic | Show diffs, approve/reject |
| Polishing | Tool | Apply mechanical changes on demand |

A flat chat UI obscures these phases. Caco can expose them: a session has a current phase, and the available interactions change with it.

**Implication for Caco:** Phase-aware UI — different interaction primitives surface in different phases. During review, accept/reject on diffs. During exploration, scope pickers. During execution, observation panels.

### 3. The output surface is becoming an input device

**(Source: shipping products research)**

Bolt.new's "Fix with Bolt" button on a runtime error → one-click structured prompt. Lovable's click-to-select on a rendered component → spatial intent. v0's drag-select on a UI region → bounded-box prompt. Cursor's Tab-chaining through a refactor → predicted next edit site.

The output is no longer a dead artifact. It's the next input.

**Implication for Caco:** Things rendered in chat or applets should be interactive surfaces. A tool call result with a file list should let you click a file. An error message should offer "Diagnose this." A generated SVG diagram should let you click a node to ask about it.

### 4. Context assembly is the deepest design divide

**(Source: shipping products research)**

Four shipping products give four different answers to "what does the AI know?":
- **Cursor:** explicit `@`-mentions plus a vector codebase index.
- **Windsurf/Cascade:** ambient observation of editor and terminal — no explicit invocation.
- **Aider:** symbol graph of the whole repo.
- **Devin:** team-edited persistent wiki.

Caco today is closer to Cursor (explicit pound-completion) plus Aider (whole-session memory). The Devin-like persistent wiki is what `caco_set_memory` and the session-context applet are starting to build.

**Implication for Caco:** Continue to invest in **explicit, visible context selection**. Users should always be able to see and edit what the agent knows about their work. The opaque ambient model is too hard to debug when it goes wrong.

### 5. Reliable structured output is the prerequisite

**(Source: HCI research, Outlines/grammar-constrained generation, Chameleon)**

You can't build reactive UIs on top of free text. Every interaction pattern in this paper depends on the agent producing typed output: a JSON manifest of diffs, a list of hypotheses with status enums, a tree of files with selection state, a parameter object with named knobs.

`set_applet_state` already gives Caco the channel. What's missing is the convention that agents emit structured state as a matter of course, not just when explicitly asked.

**Implication for Caco:** Tool descriptions and the system prompt should encourage structured emission. Adding tools that take typed parameters (like `caco_offer_options` does today) makes the structure obvious.

## Twelve concrete patterns for Caco

The following patterns are buildable with Caco's existing primitives — applets, `set/get_applet_state`, inline HTML/SVG, `caco_offer_options`, and tool file I/O. All have been pre-validated as plausibly small implementations.

### A. Steering & oversight (during agent work)

**1. Live observation panel.** Side-panel applet with a checklist of named stages and a real-time log of `session_note` entries. Agent calls `set_applet_state({ stage, log })`. User sees progress and can intervene before a bad result.

**2. Undo affordance.** When the agent takes a small action (created a file, ran a command, set memory), surface a contextual "Undo" button near the action's output that's visible while the session is idle. Click reverses the action and posts a revert message into chat. Replaces approval pauses for low-risk reversible operations.

**3. Hypothesis ladder.** During debugging, agent renders an inline SVG tree of hypotheses, color-coded by status. Each leaf has a one-click "Run this test" button that sends the command back to chat. The tree updates as tests run.

### B. Selection & scoping (before agent work)

**4. Codebase scope picker.** Applet renders a file tree with directory checkboxes. User selects scope; the agent's next operation is constrained to those paths. Pill summary in subsequent replies shows "scoped to: src/auth, src/middleware".

**5. Multi-select queue.** Agent produces N candidates (files to refactor, tickets to triage, errors to investigate). User checkboxes which ones to act on. Selection becomes the agent's next-turn working set.

**6. Pinned actions.** User-defined one-click prompts in `~/.caco/actions.json` rendered as pills near the input. Click sends the prompt. Zero cost when empty, tiny when populated. (Already specced in `ui-session-interaction.md`.)

### C. Approval & review (after agent work)

**7. Diff approval board.** Agent writes a manifest of file edits to a JSON file and opens a diff applet. User accept/rejects each file with checkboxes. "Commit accepted" runs only the approved patches. Rejected files come back to the agent with the user's reason.

**8. Annotation thread on output.** Inline comments on agent-generated documents (specs, plans). User leaves comments; agent reads them on next turn and produces a revision incorporating the feedback. The comment thread IS the change request.

### D. Exploration (open-ended)

**9. Replay scrubber.** Timeline applet with a playhead over `session_note` entries. Drag the scrubber to jump to a specific moment in the session. "What were you thinking here?" without scrolling chat.

**10. Branching session preview.** At a fork ("Postgres or SQLite?"), agent spawns two child swarm sessions in parallel, each pursuing one path. Their results render side by side. User picks one; the loser is archived. (Uses existing swarm tool.)

### E. Direct manipulation (steering by example)

**11. Parameter tuner.** Agent generates a custom HTML applet at `/tmp/tuner.html` with sliders/dropdowns for the magic numbers in its output. User adjusts; values flow back via `setAppletState`; agent regenerates the config and offers re-run. The slider IS the steering instruction.

**12. Inspector property delta.** When viewing structured output (a config, a JSON tree, a parsed AST), user edits one property and clicks "propagate this style." Agent reads the delta and applies the equivalent change across the broader context.

## What ties them together

Every pattern follows the same shape:

```
┌─────────────────────────────────────────────────────┐
│ Agent structures                                    │
│   ↓                                                 │
│   tool emits typed state (diffs, options, tree...)  │
│   ↓                                                 │
│ Applet/inline renders                               │
│   ↓                                                 │
│   user clicks/drags/selects                         │
│   ↓                                                 │
│ State flows back via setAppletState or message     │
│   ↓                                                 │
│ Agent reads state and continues                     │
└─────────────────────────────────────────────────────┘
```

This is the same loop that `caco_offer_options` already implements, generalized. Every new pattern is a richer surface for the same loop.

## Seven design principles

Adopted from the swarm research, refined for Caco:

1. **State flows both ways.** Every interactive surface has both `set_applet_state` (agent → UI) and `get_applet_state` (UI → agent). No one-way views.
2. **No new modal UI.** Use existing primitives — applets, inline HTML/SVG, response options. Don't introduce new floating windows or panel types.
3. **Progressive disclosure.** Empty state is invisible. Surfaces appear when the agent emits the right kind of output, vanish when not needed.
4. **Chat message is canonical.** Every interaction is anchored to a chat message (the message that opened the applet, sent the options, rendered the SVG). Scrolling back works.
5. **Agent writes / user clicks.** Division of labour: agents are strong at producing structured state; users are strong at making bounded choices. Don't ask users to produce structure or agents to make value judgments.
6. **Reversible actions over permission requests.** Prefer undo-able actions to pauses-for-approval. Approval fatigue is real and most decisions are low-risk. When sessions are idle, surface "undo last" affordances near the affected output. Pauses should be reserved for genuinely irreversible operations (delete, send email, deploy).
7. **Natural language is always available.** Even when interactive surfaces offer next-step options, the chat input remains the canonical way to amend, replace, or add nuance. Surfaces are accelerators, not replacements.

## Open architectural questions

Two cross-cutting questions affect any of these patterns and should be resolved before deep investment.

### Question 1: Should the applet panel be owned by the chat view?

Today, applets are top-level UI: the panel is independent of which session is active. Switching sessions does not change the active applet, though some applets react to session changes by re-fetching.

**Argument for flipping:** If an applet represents work *about* a session (a roadmap, a diff approval board, an observation panel), it logically belongs to that session. Switching to a different session should restore that session's last applet. The current model means a user looking at session A's diff board, switching to session B, and switching back loses the board context.

**What changes:**
- Active applet slug + URL params stored in session metadata.
- URL becomes session-first: `?session=<id>&applet=<slug>&...` instead of `?applet=<slug>&session=<id>`.
- On session switch, applet panel restores to the session's last-active applet (or empty if none).
- Applets that should be global (file-finder for an arbitrary path, html-viewer for a file outside any session) can opt out via a `meta.json` flag.

**Argument against flipping:** Some applets are inherently global — file-finder for `~`, presentation for an arbitrary file, mcp-servers config. Forcing every applet under a session breaks those. The current model is simple: applet URL is the source of truth.

**Recommendation:** Investigate, but treat as a separate work item. The patterns proposed in this paper can ship under either model. The flip is a refactor that affects routing, history, and applet lifecycle.

### Question 2: How many tools can an agent reliably remember?

Several patterns in this paper imply new tools (`caco_propose_diff`, `caco_open_observation`, `caco_render_hypothesis_tree`, `caco_pin_action`...). Each tool description costs tokens and adds confusion; long-lived sessions forget them.

**Constraint:** Caco already has 30+ tools. Adding 12 patterns × 1 tool each is unrealistic.

**Mitigation strategies:**

- **One generic surface tool, many uses.** Instead of `caco_render_hypothesis_tree`, a single `caco_render_panel(html, state_schema)` that takes arbitrary HTML and a state schema. The agent generates the markup; Caco renders and wires it. This trades structure for flexibility but matches the article's "agent generates HTML on the fly" pattern.
- **Convention over tooling.** Patterns become *prompt patterns* — the system prompt teaches "when debugging, emit an SVG tree like this and the user will be able to click branches." No new tool. The interactive behavior comes from existing inline-HTML rendering plus standard event delegation.
- **Tool families with one entry point.** `caco_render` with a `kind` parameter (kind: 'hypothesis-tree' | 'diff-board' | 'scope-picker' | ...). Caco maps `kind` to a specific renderer. Tool count stays small; richness grows by adding renderer types.
- **Rely on `caco_offer_options` and `set_applet_state` more.** They already cover ~60% of the patterns. The expensive ones are the ones that need new tools.

**Recommendation:** Pick **one generic surface tool** as the main investment. Patterns become *kinds* registered with that tool. Sessions only need to remember one tool name to access the entire interaction layer. The generic tool can be polished, well-described, and tested for reliability across model sizes.

**Reliability note:** Even with a generic tool, Sonnet-level models will sometimes forget. Mitigations: (a) invoke the tool from system-prompt nudges at relevant moments ("when you have multiple file edits to propose, use caco_render with kind='diff-board'"); (b) make the tool's failure mode silent — if the agent doesn't use it, the chat still works; (c) measure usage to identify which patterns the agent actually adopts.


## Anti-patterns to avoid

- **Modal dialogs.** A pop-up that blocks chat is a regression from the response options pattern.
- **Settings sprawl.** Every new pattern adding new config knobs is friction. Defaults should work.
- **Pseudo-IDE.** Caco isn't VS Code. The interaction surface is the chat-applet split, not a multi-pane editor with menus and toolbars.
- **Hidden state.** Surfaces that store user input but don't show what they're storing erode trust. Show selections as pill summaries in chat.
- **Voice/gesture/AR.** Out of scope. Browser + mouse + keyboard is the medium.

## Implementation sequence

Patterns in roughly increasing complexity:

| Tier | Patterns | Effort |
|------|----------|--------|
| 1 (small) | Pinned actions (#6), pause checkpoint (#2) | 1 day each |
| 2 (medium) | Live observation panel (#1), codebase scope picker (#4), diff approval board (#7) | 2-3 days each |
| 3 (medium) | Hypothesis ladder (#3), multi-select queue (#5), replay scrubber (#9) | 3-5 days each |
| 4 (large) | Annotation thread (#8), parameter tuner (#11), branching session preview (#10), inspector delta (#12) | 1-2 weeks each |

Tier 1 patterns are essentially extensions of `caco_offer_options`. Tier 2 patterns are new applets with the existing API. Tier 3 introduces richer state schemas and tool conventions. Tier 4 has design depth and may need spec passes.

## Reference: source documents

The research summaries that fed this paper:

- `/tmp/swarm-1-research.md` — HCI and academic papers (Spatial Mark Anchoring, ReAct trace exposure, ghost text economics, phase-aligned collaboration, structured generation)
- `/tmp/swarm-2-products.md` — Shipping AI products (Cursor, Windsurf, Bolt, Lovable, v0, Canvas, Devin, Aider, Continue, etc.)
- `/tmp/swarm-3-uipatterns.md` — Web UI patterns (grids, node graphs, timelines, canvases, file trees, diff viewers, command palettes, inspectors, annotations)
- `/tmp/swarm-4-caco-patterns.md` — Caco-specific brainstorm with 12 concrete pattern proposals

These are kept in `/tmp` and not committed — they're raw input. This document is the curated synthesis.
