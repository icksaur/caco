# DOM Modification Audit

Deep analysis of every source of DOM modification in the Caco frontend, the strategies each uses to target and scope its changes, and known incompatibilities causing regressions around the thinking feedback, context footer, and applet panel features.

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [DOM Tree Map](#dom-tree-map)
3. [Complete Inventory of DOM Modifiers](#complete-inventory-of-dom-modifiers)
4. [External Libraries](#external-libraries)
5. [Element Lookup Strategies](#element-lookup-strategies)
6. [The Three Regression Patterns](#the-three-regression-patterns)
7. [Interaction Matrix](#interaction-matrix)
8. [Root Cause Analysis](#root-cause-analysis)
9. [Recommendations](#recommendations)

---

## Executive Summary

We have **21 TypeScript files** that modify the DOM, **4 external libraries** that transform DOM content, and **no unified strategy** for ensuring they don't interfere with each other. The regressions around thinking feedback, context footer, and applet panels all stem from the same architectural gap: **multiple independent DOM modifiers operate on overlapping element scopes without coordination, using inconsistent lookup strategies**.

The critical failure modes:

1. **`hideThinkingIndicator()` removes the entire `assistant-activity` outer div** — destroying all sibling tool/intent content within it.
2. **`renderMarkdownElement()` replaces `innerHTML` of elements** — this can destroy adjacent content (context footer, applet elements) when hljs or markdown rendering targets too broadly.
3. **Element lookup inconsistency**: some code uses `getElementById`, some uses `querySelector` with data attributes, some uses class-based `.closest()`. When markdown rendering injects HTML containing IDs or classes that match our selectors, lookups return the wrong elements.

---

## DOM Tree Map

The static HTML structure from `index.html`, annotated with which modules own each region:

```
body
├── #menuBtn                          [view-controller, session-panel]
├── #appletBtn                        [router, applet-button]
├── #expandBtn                        [router, view-controller]
├── #sessionView .session-overlay     [view-controller, session-panel]
│   └── .session-content
│       ├── #usageInfo                [session-panel]
│       ├── #sessionSearchInput       [session-panel]
│       ├── #actionBtn                [session-panel]
│       ├── #schedulesList            [session-panel]
│       └── #sessionList              [session-panel]
├── main
│   └── .work-area
│       ├── #chatPanel .chat-panel
│       │   ├── #chatScroll .chat-scroll
│       │   │   └── #chatView .chat-view
│       │   │       ├── #newChat .new-chat         [view-controller, model-selector]
│       │   │       │   └── #modelList             [model-selector]
│       │   │       ├── #chat .hidden              [message-streaming, element-inserter]
│       │   │       │   ├── .user-message          ← DYNAMIC [element-inserter]
│       │   │       │   │   └── .user-text         ← DYNAMIC [event-inserter]
│       │   │       │   ├── .assistant-activity     ← DYNAMIC [element-inserter]
│       │   │       │   │   ├── .thinking-text     ← DYNAMIC [event-inserter] ⚠️ REMOVED BY hideThinkingIndicator
│       │   │       │   │   ├── .intent-text       ← DYNAMIC [event-inserter]
│       │   │       │   │   ├── .tool-text         ← DYNAMIC [event-inserter, markdown-renderer]
│       │   │       │   │   └── .reasoning-text    ← DYNAMIC [event-inserter, streaming-markdown]
│       │   │       │   └── .assistant-message      ← DYNAMIC [element-inserter]
│       │   │       │       └── .assistant-text     ← DYNAMIC [event-inserter, streaming-markdown]
│       │   │       └── #workingCursor             [message-streaming]
│       │   └── footer#chatFooter
│       │       ├── #imagePreview                  [image-paste]
│       │       ├── #chatForm                      [message-streaming]
│       │       └── #contextFooter [data-context-footer] [context-footer] ⚠️ DISAPPEARS
│       │           └── .context-links             [context-footer]
│       └── #appletPanel .applet-panel .hidden     [view-controller, router]
│           └── #appletView [data-applet-view]     [applet-runtime] ⚠️ DISAPPEARS
│               └── .applet-instance               ← DYNAMIC [applet-runtime]
├── #toast                                         [toast]
└── <script type="module" src="bundle.js">
```

**Legend:**
- ⚠️ = Element subject to regressions
- DYNAMIC = Created/destroyed at runtime by the noted module
- `[module]` = Primary owner(s) of that DOM region

---

## Complete Inventory of DOM Modifiers

### Tier 1: Chat Content Pipeline (high frequency, high risk)

These run on every WebSocket event during streaming. They are the most critical to get right.

#### 1. `element-inserter.ts` — Structural Element Management

**What it does:** Creates/reuses the outer and inner `<div>` elements for each chat event. Two-level nesting: outer (message type) → inner (content type).

**Lookup strategy:**
- **Un-keyed events**: Checks if `parent.lastElementChild` has the target CSS class. If yes, reuses it. If no, creates a new div and appends.
- **Keyed events** (tools, reasoning, messages): Uses `parent.querySelector([data-key="value"])` to find existing element by `data-key` attribute. If not found, creates new div with `data-key` set.

**DOM mutations:**
- `document.createElement('div')`
- `parent.appendChild(div)`
- Sets `div.className` and `div.dataset.key`

**Scope limitation:** Only operates within the parent element passed to it (always `#chat` for outer, and the outer div for inner). Never reaches outside `#chat`.

**Risk:** Low in isolation. It creates structure but doesn't modify content.

#### 2. `event-inserter.ts` — Content Injection

**What it does:** Given an inner element and event data, sets the content. Uses `textContent` for most events, `innerHTML` for embeds.

**Lookup strategy:** Operates only on the element passed to it (no DOM queries).

**DOM mutations:**
- `element.textContent = value` (most events)
- `element.innerHTML = purify.sanitize(data)` (embeds only)
- `element.dataset.toolName = name` (tool events)
- Calls `window.renderMarkdownElement(element)` for user messages, assistant messages, tool.execution_complete, and assistant.reasoning
- Calls `finalize()` / `handleDelta()` from streaming-markdown for assistant.message/delta

**Scope limitation:** Strictly modifies only the element it receives. Does not search the DOM.

**Risk:** Medium. The `renderMarkdownElement` call replaces `element.innerHTML`, which is fine for the target element. But see markdown-renderer section for broader risks.

#### 3. `message-streaming.ts` — Event Orchestrator

**What it does:** The central event handler. Receives WebSocket events, coordinates element-inserter and event-inserter, handles special cases.

**Lookup strategy:**
- `document.getElementById('chat')` — the chat container
- `document.querySelector('.thinking-text')` — thinking indicator lookup ⚠️
- `thinking.closest('.assistant-activity')` — traverse up to find parent ⚠️
- `chat.querySelectorAll('.streaming-cursor')` — find all cursors on terminal events
- `chat.querySelector([data-key="reasoningId"])` — find reasoning element across entire chat

**DOM mutations:**
- `outer.remove()` via `hideThinkingIndicator()` ⚠️ **CRITICAL**
- `el.classList.remove('streaming-cursor')` — remove cursor class on terminal events
- `inner.classList.add('collapsed')` — collapse reasoning after streaming
- Click handler toggles `.collapsed` on inner activity items

**Risk: HIGH.** The `hideThinkingIndicator()` function is the primary source of the activity div disappearance bug. See [Root Cause Analysis](#root-cause-analysis).

#### 4. `streaming-markdown.ts` — Incremental Markdown Rendering

**What it does:** Accumulates delta content for assistant messages, renders markdown periodically (batched for performance), shows unrendered "tail" text between renders.

**Lookup strategy:**
- `element.querySelector('.streaming-tail')` — find tail span within element

**DOM mutations:**
- `element.querySelector('.streaming-tail')?.remove()` — remove tail before re-render
- `element.textContent = rawContent` — set text before markdown render
- `window.renderMarkdownElement?.(element)` — trigger markdown rendering
- Creates/updates `<span class="streaming-tail">` with unrendered content

**Scope limitation:** Strictly operates within the single element passed to `handleDelta()` or `finalize()`. Module-level `Map<string, StreamingState>` tracks state by messageId.

**Risk:** Low. Well-scoped. Timer-based rendering could theoretically fire after element is removed, but the Map cleanup in `finalize()` prevents this.

### Tier 2: Markdown & Syntax Highlighting (content transformation, medium risk)

#### 5. `markdown-renderer.ts` — Markdown + Mermaid + hljs

**What it does:** Two functions with very different scopes:

**`renderMarkdown()` (batch mode, page load):**
- Queries `document.querySelectorAll('[data-markdown]')` — globally
- Processes all `.markdown-content` children within each
- Sets `contentDiv.innerHTML = sanitized HTML`
- Renders Mermaid diagrams within content
- Then runs `hljs.highlightElement()` on `#chat pre code` blocks only

**`renderMarkdownElement(element)` (incremental, per-event):**
- Takes a single element
- Sets `element.innerHTML = sanitized HTML`
- Adds `markdown-content` class to element
- Preserves `streaming-cursor` class

**Lookup strategy:**
- Batch: `document.querySelectorAll('[data-markdown]')` — GLOBAL ⚠️
- Batch hljs: `document.getElementById('chat')` then `chat.querySelectorAll('pre code')` — scoped to chat
- Incremental: operates only on passed element

**DOM mutations:**
- `element.innerHTML = html` — replaces entire element content
- `element.classList.add('markdown-content')` — adds styling class
- Mermaid: `div.innerHTML = svg` — replaces diagram placeholder

**DOMPurify config:**
- Strips `id` attribute (FORBIDDEN_ATTRS) — defense against ID collisions
- Strips event handler attributes (onclick, etc.)
- Strips `<script>`, `<iframe>`, `<form>`, `<input>`, etc. (FORBIDDEN_TAGS)

**Risk: MEDIUM-HIGH.** The batch `renderMarkdown()` uses a global selector `[data-markdown]`. If any markdown-rendered chat content contains `data-markdown` attributes, it could re-process already-rendered content. The incremental function is safe but the `innerHTML =` completely replaces the element's children — any child elements inserted by other code (like streaming tails) are destroyed.

#### 6. External: `hljs` (highlight.js)

**What it does:** Syntax highlighting for code blocks.

**Called from:**
- `markdown-renderer.ts renderMarkdown()` — batch mode, scoped to `#chat pre code`
- NOT called from `renderMarkdownElement()` (incremental)

**DOM mutations:**
- `hljs.highlightElement(block)` — replaces text content of `<code>` elements with syntax-highlighted HTML spans
- Adds `hljs` class and language-specific classes

**Scope limitation:** Only called within `#chat` context. The CSS class `nohighlight` on `#contextFooter` was added as defense, but hljs is already scoped by the code that calls it.

**Risk:** LOW (properly scoped to `#chat`).

#### 7. External: `marked` (markdown parser)

**What it does:** Parses markdown text to HTML string. Pure function — does NOT touch DOM directly.

**Called from:** `markdown-renderer.ts`

**DOM mutations:** None directly. Returns HTML string that is then sanitized and assigned to `innerHTML`.

**Risk:** LOW. The generated HTML goes through DOMPurify. However, the `code()` renderer creates `<div>` elements with auto-generated `id` attributes for Mermaid diagrams. These IDs are of the form `mermaid-XXXXX` and don't collide with app IDs.

#### 8. External: `DOMPurify`

**What it does:** Sanitizes HTML to prevent XSS. Strips forbidden tags and attributes.

**Called from:** `markdown-renderer.ts` (both functions), `event-inserter.ts` (embed content)

**DOM mutations:** None directly. Operates on HTML strings. Returns sanitized string.

**Key config:** `FORBID_ATTR: ['id', ...event handlers]` — this strips `id` attributes from rendered content, which was added in commit `7a30fdd` to fix ID collision bugs.

**Risk:** LOW. This is defensive. The `id` stripping specifically prevents rendered chat content from creating elements with IDs like `appletView` or `contextFooter` that would confuse `getElementById` calls.

#### 9. External: `mermaid`

**What it does:** Renders Mermaid diagram markup into SVG.

**Called from:** `markdown-renderer.ts renderMarkdown()` only (batch mode)

**DOM mutations:**
- `div.innerHTML = svg` — replaces diagram placeholder content with rendered SVG
- On error: `div.innerHTML = error HTML`

**Risk:** LOW. Scoped to `.mermaid-diagram` divs within chat content.

### Tier 3: View State & Layout (structural visibility, medium risk)

#### 10. `view-controller.ts` — View State Machine

**What it does:** Single source of truth for which view is active (sessions | newChat | chatting). Controls visibility of major panels.

**Lookup strategy:** Caches elements on first access via `getElements()`:
- `document.getElementById('chatScroll')`
- `document.getElementById('sessionView')`
- `document.getElementById('appletPanel')`
- `document.getElementById('appletView')`
- `document.getElementById('chat')`
- `document.getElementById('newChat')`
- `document.getElementById('chatFooter')`
- `document.getElementById('menuBtn')`
- `document.getElementById('appletBtn')`
- `document.getElementById('expandBtn')`

**DOM mutations:**
- Toggles `.active`, `.hidden`, `.expanded` classes on cached elements
- `document.querySelector('.expand-icon')` — updates expand button text

**Scope limitation:** Only modifies the 10 cached top-level elements. Never reaches into `#chat` children.

**Risk: MEDIUM.** The caching strategy (`cachedElements`) caches element references at first access. If an element is removed and re-created (unlikely for these top-level IDs), the cache would hold stale references. More importantly: **if `getElementById` returns a wrong element due to ID collision, the cached reference points to rendered chat content instead of the real UI element, and ALL subsequent view state changes modify the wrong element.**

This was the root cause of the ID collision bug fixed in `7a30fdd`. The defense-in-depth now includes:
1. DOMPurify strips `id` from rendered content
2. `#appletView` also has `data-applet-view="true"` attribute
3. `#contextFooter` also has `data-context-footer="true"` attribute

#### 11. `router.ts` — Navigation & Session Switching

**What it does:** Handles Navigation API events, session switching, applet loading.

**Lookup strategy:**
- `document.getElementById('chat')` — to clear on session switch
- `document.querySelector('.input-text')` — to focus after toggle

**DOM mutations:**
- `chat.innerHTML = ''` — clears chat when switching sessions ⚠️
- Calls `setViewState()`, `showAppletPanel()`, `hideAppletPanel()` — delegates to view-controller
- Calls `pushApplet()` — delegates to applet-runtime

**Risk:** LOW. The `chat.innerHTML = ''` is a clean wipe for session switching.

#### 12. `context-footer.ts` — Meta-Context Footer

**What it does:** Renders file links and applet links in a persistent footer below chat input.

**Lookup strategy:**
- `document.querySelector('[data-context-footer="true"]')` — uses data attribute, NOT getElementById ⚠️
- `footer.querySelector('.context-links')` — finds links container within footer

**DOM mutations:**
- `linksContainer.innerHTML = links.join(separator)` — replaces link content
- `footer.classList.add/remove('has-context')` — controls visibility via CSS

**Scope limitation:** Strictly modifies only the `#contextFooter` element and its `.context-links` child. Uses data attribute selector to avoid ID collision issues.

**Risk: MEDIUM.** The footer works correctly in isolation. But it can be affected by:
1. Other code that removes or hides `#chatFooter` (view-controller hides it in sessions view)
2. CSS `display: none` from `.context-footer` default style (requires `.has-context` to show)
3. Markdown rendering or hljs accidentally processing footer content (defense: `nohighlight` class, hljs scoped to `#chat`)

**Disappearance scenario:** If `renderContextFooter()` is called and the `querySelector('[data-context-footer="true"]')` returns `null` (element not in DOM or was removed), the function silently returns. This can happen during view state transitions or if the element was briefly removed.

#### 13. `applet-runtime.ts` — Applet Lifecycle

**What it does:** Loads applet content (HTML/CSS/JS) into the applet panel.

**Lookup strategy:**
- `document.querySelector('[data-applet-view="true"]')` — uses data attribute, NOT getElementById
- `document.querySelector('.applet-instance[data-slug="slug"]')` — for applet JS scoping
- `document.querySelectorAll('script[data-applet-slug="slug"]')` — for cleanup

**DOM mutations:**
- `container.innerHTML = content.html` — injects applet HTML
- Creates `<style>` and `<script>` elements, appends to `<head>` and `<body>`
- `instanceDiv.remove()` — destroys applet instance
- `styleElement.remove()` — removes applet CSS
- `instance.element.style.display = 'block' | 'none'` — show/hide

**Risk: MEDIUM.** Applet CSS and JS are injected globally. Applet CSS could potentially affect elements outside the applet panel if selectors are too broad. The `data-applet-slug` attribute scoping for script elements is good practice.

**Disappearance scenario:** If `document.querySelector('[data-applet-view="true"]')` returns `null`, the applet fails to load with a console error. This would happen if:
- The `data-applet-view` attribute was stripped (it's not in rendered content, so DOMPurify doesn't matter here)
- The `#appletPanel` was removed from DOM (it's static HTML, so this shouldn't happen)
- The `#appletView` element's ID was found by `getElementById` but the data attribute query matched a different element (shouldn't happen, but indicates the fragility)

### Tier 4: Session Management (session list UI, low risk to chat)

#### 14. `session-panel.ts` — Session List

**What it does:** Renders session list, schedule list, usage info.

**Lookup strategy:**
- `document.getElementById('sessionList')`
- `document.getElementById('schedulesList')`
- `document.getElementById('usageInfo')`
- `document.getElementById('unobservedBadge')`
- `document.getElementById('menuBusyIndicator')`
- `document.querySelector('.session-item[data-session-id="id"]')`
- `item.querySelector('.session-busy-indicator')`
- `item.querySelector('.session-delete')`
- `item.querySelector('.session-summary')`

**DOM mutations:**
- `container.innerHTML = ''` — clears session list
- Creates session items with `document.createElement`
- Toggles `.busy`, `.active`, `.unobserved` classes
- Adds/removes busy indicator and delete button elements

**Risk:** LOW. Entirely within `#sessionView`, which is a separate overlay. No interaction with chat content.

### Tier 5: Input & Form Handling (low risk)

#### 15. `message-streaming.ts` (form handling part)

**DOM mutations:**
- `form.classList.add/remove('streaming')` — toggles form state
- `cursor.classList.add/remove('hidden')` — show/hide working cursor
- `input.focus()` — focus chat input

#### 16. `image-paste.ts`

**DOM mutations:**
- `imageData.value = base64` — hidden input
- `previewImg.src = base64` — preview image
- `imagePreview.classList.add/remove('visible')` — show/hide preview

#### 17. `multiline-input.ts`

**DOM mutations:**
- `textarea.style.height = 'Npx'` — auto-resize
- `textarea.style.overflowY = 'auto' | 'hidden'`

#### 18. `model-selector.ts`

**DOM mutations:**
- `container.innerHTML = ''` — clears model list
- Creates model items with `document.createElement`
- Toggles `.active` class on model items
- Sets `input.placeholder` text

#### 19. `toast.ts`

**DOM mutations:**
- `toast.classList.add/remove('hidden')` — show/hide
- `toast.classList.add/remove('toast-error'/'toast-success'/'toast-info')` — type classes
- `messageSpan.textContent = message` — set message text

#### 20. `hostname-hash.ts`

**DOM mutations:**
- Creates `<canvas>` element (not appended to document body)
- Removes existing `<link rel="icon">` from head
- Creates new `<link>` favicon element
- Sets CSS custom properties on `document.documentElement`

#### 21. `app-state.ts`

**DOM mutations:**
- `document.getElementById('selectedModel').value = modelId` — syncs hidden input

---

## External Libraries

| Library | Files | Loaded As | DOM Scope | Touches |
|---------|-------|-----------|-----------|---------|
| **marked** | `marked.min.js` | Global `marked` | None (string transform) | Returns HTML string |
| **DOMPurify** | `purify.min.js` | Global `DOMPurify` | None (string transform) | Returns sanitized string |
| **highlight.js** | `highlight.min.js` | Global `hljs` | `#chat pre code` only | Replaces `<code>` innerHTML |
| **mermaid** | `mermaid.min.js` | Global `mermaid` | `.mermaid-diagram` only | Replaces div innerHTML with SVG |

All four external libraries are either pure string transforms or properly scoped to `#chat` content. They are NOT the cause of the footer/applet disappearance bugs.

---

## Element Lookup Strategies

The codebase uses **five different strategies** to find elements. This inconsistency is itself a source of bugs:

### Strategy 1: `getElementById` (fragile with rendered content)

**Used by:** view-controller.ts, message-streaming.ts, model-selector.ts, session-panel.ts, image-paste.ts, multiline-input.ts, toast.ts, app-state.ts, history.ts

**Problem:** Returns first element with matching ID. If rendered chat content contains an element with the same ID, the wrong element is returned. Partially mitigated by DOMPurify stripping `id` attributes from rendered markdown, but content set via `textContent` (not markdown) or embed `innerHTML` could still introduce IDs.

### Strategy 2: `querySelector` with data attribute (robust)

**Used by:** context-footer.ts (`[data-context-footer="true"]`), applet-runtime.ts (`[data-applet-view="true"]`)

**Problem:** None. Data attributes are not present in rendered content. This is the most robust strategy.

### Strategy 3: `querySelector` with CSS class (fragile)

**Used by:** message-streaming.ts (`.thinking-text`), session-panel.ts (`.session-item`), markdown-renderer.ts (`[data-markdown]`, `.markdown-content`)

**Problem:** Class names from rendered markdown content could match. The `.thinking-text` lookup is particularly dangerous — it searches the ENTIRE document, not just `#chat`.

### Strategy 4: `element.querySelector` scoped to parent (safe)

**Used by:** element-inserter.ts (`parent.querySelector([data-key])`), streaming-markdown.ts (`.streaming-tail`), context-footer.ts (`.context-links`)

**Problem:** None. Scoped to a known parent element.

### Strategy 5: `element.closest()` (traversal, fragile)

**Used by:** message-streaming.ts (`thinking.closest('.assistant-activity')`)

**Problem:** Traverses UP the DOM tree. If the thinking element is inside deeply nested content (unlikely but possible with markdown), it could find the wrong ancestor.

---

## The Three Regression Patterns

### Regression 1: Activity Div Disappears (Thinking Feedback)

**Symptom:** After `assistant.turn_start` event, the "💭 Thinking..." message appears. When a content event arrives (intent, tool, message_delta), `hideThinkingIndicator()` removes the `.thinking-text` element AND its parent `.assistant-activity` div. Any tool calls or intents that were inserted into the SAME `.assistant-activity` div are destroyed.

**Code path:**
```
WebSocket event arrives
  → handleEvent()
    → CONTENT_EVENTS.has(eventType) → true
      → hideThinkingIndicator()
        → document.querySelector('.thinking-text')  // finds thinking element
        → thinking.closest('.assistant-activity')    // finds the outer activity div
        → outer.remove()                             // REMOVES ENTIRE ACTIVITY BOX ⚠️
```

**The problem:** The outer `.assistant-activity` div may contain BOTH the `.thinking-text` AND other inner elements (intent, tool calls) that were inserted BETWEEN the `turn_start` and the first content event. Removing the entire outer div destroys those too.

**Timeline of a typical failure:**
```
1. assistant.turn_start → creates .assistant-activity, creates .thinking-text inside it
2. assistant.intent → CONTENT_EVENT → hideThinkingIndicator() removes the .assistant-activity
   But wait — the intent itself was supposed to be in this activity div!
   The outerInserter for 'assistant.intent' maps to 'assistant-activity'.
   If the thinking and intent are in the SAME activity div...
   → The intent is either never shown, or is shown then immediately destroyed.
```

**Actually, it's worse.** Looking at the code flow more carefully:

```javascript
// In handleEvent():
if (CONTENT_EVENTS.has(eventType)) {
  hideThinkingIndicator();   // ← removes .assistant-activity div
}

// Then later in same function:
const outer = outerInserter.getElement(eventType, chat);  // ← creates NEW .assistant-activity
```

So the sequence is: destroy the activity div, then create a new one. This means the intent/tool works, but ANY content that was in the destroyed activity div (from a prior event in the same turn) is lost.

**But the REAL issue:** If `hideThinkingIndicator()` runs but no new activity div is created (because the event maps to a different outer class, like `assistant-message`), then the entire activity section for that turn is gone.

### Regression 2: Context Footer Disappears

**Symptom:** The footer with file links and applet links disappears. The DOM element exists but has no visible content.

**Potential causes:**

1. **`clearContextFooter()` called at wrong time**: Called from `history.ts waitForHistoryComplete()` and `view-controller.ts setViewState('newChat')`. If a context event arrives during history loading but after the clear, the footer stays empty.

2. **CSS hides it**: `.context-footer` has `display: none` by default. Only `.context-footer.has-context` makes it visible. If `renderContextFooter()` is called with empty context, it removes `has-context` class.

3. **Footer element not found**: If `document.querySelector('[data-context-footer="true"]')` returns null, the function silently returns. This could happen if:
   - The footer is in a `display:none` parent (it IS when `#chatFooter` is hidden)
   - BUT `querySelector` still finds hidden elements, so this shouldn't matter

4. **Timing with view state transitions**: `setViewState('sessions')` hides `#chatFooter` (adds `.hidden` class). When switching back to 'chatting', the footer is un-hidden, but the context links may have been cleared during the transition.

### Regression 3: Applet Panel Content Disappears

**Symptom:** The applet panel HTML is empty — no `.applet-instance` div in the DOM despite the panel being visible.

**Potential causes:**

1. **`#appletView` lookup fails**: `applet-runtime.ts` uses `document.querySelector('[data-applet-view="true"]')`. If this returns null (element doesn't have the attribute), `pushApplet()` returns with error.

2. **Session switch clears applet content**: When `router.ts activateSession()` runs `chat.innerHTML = ''`, this only clears `#chat`, NOT `#appletView`. So this shouldn't be the issue.

3. **Applet CSS conflict**: Applet CSS is injected as a `<style>` element. If the CSS contains broad selectors (like `div { display: none }`), it could hide content outside the applet.

4. **View controller caching**: `view-controller.ts` caches `appletView` reference from `document.getElementById('appletView')`. If this initially returns null (before DOM is ready) or the wrong element (ID collision — now fixed), all applet panel visibility operations act on the wrong target.

---

## Interaction Matrix

Which modules read/write which DOM regions, and where conflicts can occur:

| DOM Region | Writers | Readers | Conflict? |
|------------|---------|---------|-----------|
| `#chat` children | element-inserter, event-inserter, streaming-markdown, markdown-renderer, message-streaming | message-streaming, streaming-markdown | Yes — `hideThinkingIndicator()` removes divs that element-inserter created |
| `#chat` (container) | router (`innerHTML=''`), history (`innerHTML=''`), message-streaming (`innerHTML=''`) | element-inserter, message-streaming | No — these are clean wipes on session switch |
| `#contextFooter` | context-footer | context-footer | No internal conflict, but external hide/show via view-controller |
| `#appletView` | applet-runtime | applet-runtime | No internal conflict |
| `#chatFooter` | view-controller (hide/show) | context-footer (querySelector) | ⚠️ Footer hidden during 'sessions' view; context events during transition may be lost |
| `pre code` in `#chat` | hljs | markdown-renderer | No — hljs is called BY markdown-renderer, in sequence |
| `.streaming-tail` | streaming-markdown | streaming-markdown | No — well-scoped |

---

## Root Cause Analysis

### Why does removing thinking code break footer and applets?

The thinking feedback code in `hideThinkingIndicator()` does:
```typescript
const thinking = document.querySelector('.thinking-text');
```
This is a **global document query**. If `.thinking-text` somehow ends up outside `#chat` (it shouldn't, but consider defensive coding), the removal could target the wrong parent.

But the real issue is more subtle. The `hideThinkingIndicator()` call is in `handleEvent()`, which processes EVERY event. The function:

1. Searches the ENTIRE document for `.thinking-text`
2. Finds its parent `.assistant-activity`  
3. Removes the ENTIRE parent, including all siblings

This is a **scoping violation**. The thinking indicator removal should:
- Only look within `#chat`
- Only remove the `.thinking-text` inner div, not the entire outer `.assistant-activity`
- Or: create a SEPARATE `.assistant-activity` div for the thinking indicator, so its removal doesn't affect other activity items

### The Deeper Pattern: Shared Outer Divs

The `element-inserter.ts` design reuses the last child of `#chat` if its class matches. This means:

```
Event: assistant.turn_start → outer class: 'assistant-activity'
  → Creates new .assistant-activity, inserts .thinking-text inside

Event: assistant.intent → outer class: 'assistant-activity'
  → Finds last child of #chat is .assistant-activity → REUSES IT
  → Inserts .intent-text inside the SAME div

Event: tool.execution_start → outer class: 'assistant-activity'
  → CONTENT_EVENT → hideThinkingIndicator() → REMOVES the .assistant-activity
  → Then outerInserter.getElement() creates NEW .assistant-activity
  → Inserts .tool-text inside it
```

The intent that was in the first `.assistant-activity` is now GONE. It was destroyed by `hideThinkingIndicator()`.

### Why removing the thinking code breaks footer/applets

When the thinking feedback code is removed entirely, the `CONTENT_EVENTS` check and `hideThinkingIndicator()` call are also removed. But wait — the regressions were about footer and applets breaking, not about thinking.

The connection: **The `assistant.turn_start` event handling in `element-inserter.ts` creates a `.assistant-activity` div**. The CSS rule:

```css
.assistant-activity .markdown-content:empty,
.assistant-activity .markdown-content:not(:has(*)) {
  display: none;
}
```

This hides empty markdown content within activity boxes. But the problem isn't CSS.

The real connection is that **multiple changes were made simultaneously** in the same commits around thinking feedback. The commit `7a30fdd` (prevent ID collisions) made changes to:
- `context-footer.ts` — added the entire file
- `markdown-renderer.ts` — added FORBIDDEN_ATTRS with 'id'
- `applet-runtime.ts` — switched from getElementById to querySelector
- `view-controller.ts` — added appletView caching
- `message-streaming.ts` — added context footer handling

These interconnected changes mean that "removing thinking code" may actually be reverting some of these fixes, causing the ID collision bugs to resurface.

---

## Recommendations

### Immediate Fix: Scoped Thinking Removal

Change `hideThinkingIndicator()` to NOT remove the entire outer div:

```typescript
function hideThinkingIndicator(): void {
  const chat = document.getElementById('chat');
  if (!chat) return;
  
  // SCOPED to #chat only
  const thinking = chat.querySelector('.thinking-text');
  if (thinking) {
    // Remove only the thinking element, NOT its parent
    thinking.remove();
    
    // If the parent .assistant-activity is now empty, remove it too
    const outer = thinking.parentElement;  // already removed, so use stored ref
    // Actually: need to get parent BEFORE removing
  }
}
```

Better approach — get parent first:

```typescript
function hideThinkingIndicator(): void {
  const chat = document.getElementById('chat');
  if (!chat) return;
  
  const thinking = chat.querySelector('.thinking-text');
  if (!thinking) return;
  
  const parent = thinking.parentElement;
  thinking.remove();
  
  // Only remove parent if it's now empty AND is an activity div
  if (parent?.classList.contains('assistant-activity') && parent.children.length === 0) {
    parent.remove();
  }
}
```

### Structural: Dedicated Thinking Container

Give the thinking indicator its own outer div that is NOT `.assistant-activity`:

```typescript
// In element-inserter.ts
'assistant.turn_start': 'assistant-thinking',  // NOT 'assistant-activity'
```

Then `hideThinkingIndicator()` can safely remove `.assistant-thinking` without affecting activity items.

### Structural: Consolidate DOM Access Patterns

All DOM lookups should follow ONE strategy. Recommended approach:

1. **Static UI elements**: Use `data-*` attributes (like `[data-context-footer="true"]`). Never use `getElementById` for elements that could be duplicated by rendered content.

2. **Dynamic chat elements**: Use scoped queries within `#chat` (like `chat.querySelector('.thinking-text')`). Never use global `document.querySelector` for classes that appear in chat.

3. **Cache invalidation**: The view-controller element cache should validate that cached elements are still in the DOM before using them.

### Structural: Formalize DOM Ownership

Each DOM region should have exactly ONE module that creates/destroys elements within it:

| Region | Owner | Others must use |
|--------|-------|-----------------|
| `#chat` children | message-streaming.ts | Nothing (events flow through message-streaming) |
| `#contextFooter` | context-footer.ts | Call `renderContextFooter()` or `clearContextFooter()` |
| `#appletView` | applet-runtime.ts | Call `pushApplet()` |
| `#sessionList` | session-panel.ts | Call `loadSessions()` |
| View visibility | view-controller.ts | Call `setViewState()` |

Currently, `hideThinkingIndicator()` in `message-streaming.ts` does its own DOM removal without going through `element-inserter.ts`. This breaks the ownership model — the inserter creates elements, but the streaming code destroys them independently.

### Testing: DOM State Assertions

Add integration tests that verify:
1. After `turn_start` + `intent` + `tool_start` events, all three inner elements exist in DOM
2. After `hideThinkingIndicator()`, intent and tool elements still exist
3. After `clearContextFooter()` + `renderContextFooter()`, footer is visible with content
4. After `session.idle`, no orphaned streaming-cursor classes exist

### Code Quality Issues (per doc/code-quality.md)

| Principle | Violation | Location |
|-----------|-----------|----------|
| **Coupling** | `hideThinkingIndicator()` knows about DOM structure (`.closest()` traversal) | message-streaming.ts:66-74 |
| **Side effects** | `renderMarkdownElement()` mutates passed element AND adds class AND may affect streaming cursor | markdown-renderer.ts:159-180 |
| **One way to do one thing** | Five different element lookup strategies | See [Element Lookup Strategies](#element-lookup-strategies) |
| **Code must be kept in sync** | Element creation in element-inserter.ts must match removal in message-streaming.ts | Two files must know same structure |
| **Relying on side effects** | `handleEvent()` has ordering dependency: hideThinking MUST run before outerInserter | message-streaming.ts:93-94 |
| **Global state** | `document.querySelector('.thinking-text')` is effectively global state lookup | message-streaming.ts:67 |

---

## Files Referenced

| File | Lines | Role |
|------|-------|------|
| `public/ts/element-inserter.ts` | 220 | Outer/inner div creation/reuse |
| `public/ts/event-inserter.ts` | 299 | Content injection per event type |
| `public/ts/message-streaming.ts` | 334 | Event orchestrator, thinking indicator |
| `public/ts/streaming-markdown.ts` | 140 | Incremental markdown during streaming |
| `public/ts/markdown-renderer.ts` | 200 | Markdown + mermaid + hljs rendering |
| `public/ts/view-controller.ts` | 259 | View state machine, panel visibility |
| `public/ts/context-footer.ts` | 126 | Meta-context footer rendering |
| `public/ts/applet-runtime.ts` | 592 | Applet lifecycle and DOM injection |
| `public/ts/router.ts` | 360 | Navigation, session/applet switching |
| `public/ts/session-panel.ts` | 698 | Session list UI |
| `public/ts/history.ts` | 64 | History loading, chat clear |
| `public/ts/toast.ts` | 79 | Toast notifications |
| `public/ts/image-paste.ts` | 57 | Image attachment preview |
| `public/ts/model-selector.ts` | 153 | Model list UI |
| `public/ts/multiline-input.ts` | 62 | Textarea auto-resize |
| `public/ts/hostname-hash.ts` | ~180 | Favicon and button colors |
| `public/ts/app-state.ts` | 202 | Hidden input sync |
| `public/ts/input-router.ts` | 87 | Keyboard event routing |
| `public/ts/button-gestures.ts` | ~100 | Touch/mouse gesture handling |
| `public/ts/ui-utils.ts` | 64 | Scroll, HTML escape, time format |
| `public/ts/main.ts` | 152 | Initialization, global exports |
| `public/index.html` | 140 | Static DOM structure |
| `public/style.css` | ~1800 | All styling incl. visibility rules |

---

## Next Step

See [doc/dom-regions.md](dom-regions.md) — spec to fix the three regression patterns identified above by establishing DOM region ownership via `scopedRoot()` helper, `regions` registry, and `ChatRegion` implementation.
