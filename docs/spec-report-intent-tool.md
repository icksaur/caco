# spec-report-intent-tool

## Goals

Restore reliable session-title population. `spec-auto-name-sessions` shipped a title-fallback ladder ending in `meta.autoName` — the first valid intent latched write-once — but its intended source (the SDK's `assistant.intent` event) is silent on current-gen models. Every unnamed session still displays "No summary".

Ship a **Caco-owned** `report_intent` tool the model calls once per session with a short USER-intent phrase, latched into `meta.autoName` via the existing pipeline. The auto-name feature lights up with no client-side changes.

## Design

### Load-bearing framing: USER intent, not agent intent

The tool captures **what the user wants accomplished**, not what the agent is currently doing.

- User-intent is roughly one string per session ("fix routing bug", "triage email"). Agent-intent shifts every turn.
- Only user-intent makes a legible title. "Reading dispatch-events.ts" tells you nothing about session identity.
- Model reliability: inferring user-intent from the first user message is a task current models do well; introspecting agent activity is fuzzier and Sol/Opus already skip it.
- User customization surface (memory key `intent-style: "prefix with domain emoji"`) composes with user-intent categorization; it does not compose with arbitrary agent activity.

The tool description authored in `prompts.ts` MUST make this distinction explicit so the model does not drift.

### Contract

**Tool:** `report_intent(intent: string) → { textResultForLlm }`

- Called by the model with a **short phrase** (target ~5 words, hard cap 200 chars) describing the user's goal for the session.
- Handler calls `setSessionIntent(sessionRef.id, intent.trim())`. The existing write-once latch stamps `meta.autoName` on the first valid call; subsequent calls update `currentIntent` and push to `intentHistory` but leave `autoName` untouched.
- Empty/whitespace inputs rejected with an actionable error at the tool boundary (belt-and-suspenders with the stamp-time `hasValidText` guard).
- Over-cap inputs rejected with a message that names the cap and the received length.
- Idempotent under replay: the write-once latch guarantees no title shimmer even if the tool fires twice in one turn.

**Response shape:**

- First-call: `Recorded session intent: "<phrase>". This is now the session title.`
- Post-latch call: `Updated current intent to "<new>". Session title stays "<original>" (locked on first call).`

The two paths are distinguishable so the model sees which case it hit and can drop the tool from later turns.

### Prompt nudge

`prompts.ts` adds one line under Behavior:

> On the first turn of a new session, call `report_intent` once with a short phrase describing what the USER wants accomplished (their goal, not your current activity). This becomes the session title.

Unconditional. The write-once latch is idempotent, so nudging even after latch costs one small tool call. Conditional-on-`autoName` nudging would require dynamic prompt build per session, which breaks the stable-prefix cache.

### Customization via user memory

`memory-tool` writes `~/.caco/memory.json`, formatted into the prompt via `formatMemoryForPrompt()`. Users add keys like:

- `intent-style: "prefix with a domain emoji: 📧 email, 📊 planning, 🐛 bug"`
- `intent-language: "always in Japanese"`

These land in the User Memory section of the prompt. The model reads them and applies to the `report_intent` argument — no code changes required.

### Registration

- `server.ts` toolFactory adds `const reportIntentTools = createReportIntentTool(sessionRef);` and appends to `allTools`.
- The tool is **NOT** deferred (must be visible from turn 1 to be nudged).
- The tool is added to `NEVER_DEFER_CACO_TOOLS` in `tool-registry.ts`. Auto-defer is usage-driven: a tool the model calls once per session (by design) would look stale to the reaper on the very next turn, be deferred, and then be invisible on the exact turn the prompt nudge fires in the *next* fresh session. This is the same self-reinforcing hazard that already protects `caco_docs`.
- The tool is a builtin (origin: `'builtin'`), catalogued for the mcp-servers applet.

### Dispatch behavior

- The handler calls `setSessionIntent` directly — authoritative.
- The pre-existing `dispatch-events.ts` capture branch for `report_intent` on `tool.execution_start` (line 90) becomes live again. It fires slightly earlier than handler completion (start vs complete). Both paths hit the same idempotent latch — safe. Keep the dispatch branch: it makes the intent visible in `meta.currentIntent` immediately, without waiting for handler resolution.
- The stale comment at `prompts.ts:60-62` naming `report_intent` as a ghost example is updated — `report_intent` is a real Caco tool now; only `list_applets` remains as the cautionary example.

## Acceptance

1. **Latch on first valid call.** Fresh session, model calls `report_intent("fix routing bug")` → `meta.autoName === "fix routing bug"` and `meta.currentIntent === "fix routing bug"`.
2. **Write-once.** Second call `report_intent("refactor auth")` → `meta.autoName` still `"fix routing bug"`; `meta.currentIntent` updates; `meta.intentHistory` has 2 entries; response text names the locked title.
3. **Empty rejected at tool entry.** `report_intent("")` and `report_intent("   ")` return an error and leave `meta` unchanged.
4. **Whitespace trimmed before storing.** `report_intent("  fix routing bug\n")` → `meta.autoName === "fix routing bug"` (no leading/trailing whitespace).
5. **Over-cap rejected.** 201-char input returns an error naming `<= 200` and the received length; `meta` unchanged.
6. **At-cap accepted.** 200-char input latches normally.
7. **Idempotent under duplicate fire.** Two calls with the same string in one turn → `intentHistory.length === 2`, `autoName` unchanged, no exceptions.
8. **Missing session guard.** With no `sessionRef.id`, handler returns an error naming the missing context.
9. **Prompt nudge present, exactly once.** `buildSystemMessage().content` contains `report_intent` exactly once, in the Behavior section, framed as USER intent.
10. **Description carries the USER framing.** Tool description contains `USER` and a negation of the agent-activity interpretation.

## Plan

- `docs/spec-report-intent-tool.md` — this spec.
- `src/report-intent-tool.ts` — new: `createReportIntentTool(sessionRef)` returning one `defineTool` with validation, cap, latch call, differentiated response text.
- `server.ts` — import + instantiate + append to `allTools`.
- `src/prompts.ts` — add Behavior bullet; update stale ghost-tool comment.
- `tests/unit/report-intent-tool.test.ts` — 11 oracles covering acceptance items 1–8, plus description shape and exactly-one-tool.
- `tests/unit/prompt-report-intent-nudge.test.ts` — 3 oracles covering acceptance items 9–10 and Behavior-section locality.
- `tests/unit/prompts-trim.test.ts` — remove `report_intent` from the ghost-tool blocklist now that it is a real tool.

## Non-goals

- **No UI changes.** The existing session-list title render already reads `titleSource === 'auto-name'` and displays `autoName`. Nothing on the client changes.
- **No archive/export shape changes.** `autoName` already rides along in the whole-directory export (verified by `archive-roundtrip-auto-name.test.ts`).
- **No agent-intent capture.** The old SDK `assistant.intent` event is left as-is in `dispatch-events.ts`; if the SDK ever starts emitting again, we gain it for free without a code change.
- **No mid-session re-titling.** A user pivot updates the sub-line (via `currentIntent`) but not the title. If users want mid-session re-title, that is a follow-up spec (would need to reset `autoName` under a user command, not a tool call).

## Rollback

Deletion candidates: `src/report-intent-tool.ts`, its test file, the wiring line in `server.ts`, the prompt nudge in `prompts.ts`, this doc. The autoName plumbing survives untouched; the ladder just goes silent again on new sessions.
