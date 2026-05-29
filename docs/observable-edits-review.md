# Spec review: observable-edits.md

Reviewed against `/home/carl/.copilot/skills/review-spec/SKILL.md` (11-item checklist) plus the targeted focus areas. Findings are graded **BLOCKER** (gap that prevents the MVP from working as specified) or **IMPORTANT** (must fix before code is written; design will be wrong otherwise). NICE-TO-HAVE items omitted per request.

---

## BLOCKER 1 — The "SDK provides `diff` on `tool.execution_complete`" claim is false

Spec §Diff computation and §Considerations / "Fidelity of `tool.execution_complete.diff`" both assert:

> `tool.execution_complete.data.result.diff` carries a unified diff for `edit` and `create` tools... verified in SDK 1.0 beta.7 types — `ToolExecutionCompleteResult.diff`.

That is not what the SDK declares. In `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts` lines 3061–3075, `ToolExecutionCompleteResult` has exactly four fields:

```ts
interface ToolExecutionCompleteResult {
  content: string;                         // concise text for LLM
  contents?: ToolExecutionCompleteContent[];
  detailedContent?: string;                // "preserves complete content such as diffs"
  uiResource?: ToolExecutionCompleteUIResource;
}
```

There is **no `diff` field**. The only places a structured `diff: string` exists in the SDK are `PermissionRequestWrite` (line 4164) and `PermissionPromptRequestWrite` (line 4434) — both fired *before* the write, gated on permission prompting, and not guaranteed to fire at all when the tool is pre-approved or running in auto-approve mode.

Implications:
- Source 1 of the diff-priority list does not exist. The whole "free, accurate, already aligned" claim collapses.
- The spec's architecture diagram and §Wire format both presume the agent path produces a diff trivially. In reality the agent path has to either (a) intercept `permission.requested` events and stash the diff before the tool runs, or (b) parse `detailedContent` heuristically (format is tool-specific and unstable), or (c) fall back to compute-on-disk on every agent edit too.

This must be redesigned before implementation. Acceptance test #1 ("Within 500ms of `tool.execution_complete`, a card appears... with a red/green diff") is unimplementable with the stated approach.

**Required action:** decide between (a) consuming `permission.requested`/`permission.completed` pairs to capture the SDK's diff, (b) treating all agent edits the same as filesystem edits (read-before/read-after with cached pre-image — but `tool.execution_complete` fires post-write, so the pre-image must be captured at `tool.execution_start`), or (c) accepting `detailedContent` parsing with explicit fragility documentation. Each has knock-on consequences for `source: 'agent'` semantics.

---

## BLOCKER 2 — `dir`-scoped lease on `cwd` does not see edits in subdirectories

Spec §Server says:

> Acquires a `dir`-scoped watch lease on the session's `cwd` (repo root)

`docs/file-watch-leases.md` §Non-goals is explicit: **"Recursive directory watching... V1 supports `file` scope and `dir` (immediate-children) scope only."** Confirmed in `src/watch-store.ts:148`: `watch(realPath, { persistent: false, recursive: false }, ...)`.

A `dir` lease on `/home/carl/repo/caco` will fire for edits to `./README.md` but **not** for `./src/foo.ts`, `./applets/observable-edits/script.js`, etc. The motivating use cases (refactor across files, external editor edits) are almost entirely sub-directory edits. The spec accidentally requires the feature `file-watch-leases.md` declared a non-goal.

Implications:
- Acceptance test #2 ("Open `vim` outside Caco, edit a file. Within 1s of save, a card appears with source `fs`") fails for ~every realistic edit location.
- Use case 2 (external edits) is broken.
- Use case 3 (`sed -i` inside a shell command) is broken for anything below repo root.

**Required action:** one of:
1. Extend `watch-store` with `tree` scope (cancels the existing non-goal — needs its own spec round, chokidar dependency, inotify-budget re-analysis since one tree watch ≈ N inotify watches).
2. Have `edit-stream-store` walk the repo and take one `dir` lease per directory — blows the 16-lease process cap on any non-trivial repo (caco itself has 50+ dirs once `node_modules` is excluded).
3. Drop filesystem-origin detection from v1 and ship agent-only. (Then §Non-Goals and the use-case list must be rewritten; this is a substantial scope cut.)

Either way the current spec as written cannot ship.

---

## BLOCKER 3 — Coalescing window vs. agent edit bursts

§Coalescing says 250 ms. §Performance: huge file counts implicitly assumes most bulk writes (e.g. `prettier --write .`) come from shell tools so check-ignore + the 50-card cap absorbs them. But the realistic agent case is "agent calls `edit` 30 times in a row, one per file, in under a second." Each call:

- emits its own `tool.execution_complete` (so no SDK-level coalescing across tools)
- writes a distinct path (so 250 ms per-path coalescing doesn't merge them — coalescing keys on `(path, window)`)

Result: a single agent turn fan-outs to N independent `caco.observable.edit` broadcasts within the same animation frame. Combined with the §Auto-scroll "↑ N new" pill design, the user gets a flood and the pill counter races. Coalescing is doing nothing for the actual bursty workload it's described as defending against.

Note also that there is no `MultiEdit` tool in this SDK (`grep MultiEdit node_modules/@github/copilot-sdk/dist/generated/ src/` returns nothing). The spec references it in §Files modified and §Server twice; that wording needs to go or the spec needs to commit to a specific multi-file tool name that actually exists (`edit`, `create` — that's it in this SDK).

**Required action:** define a *cross-path* coalescing window (e.g. "flush at most every 100 ms, batched") that the applet renders as one DOM mutation, or accept the flood and remove the pill design. Pick one, document it. Also remove `MultiEdit` references.

---

## IMPORTANT 1 — `highlight.js` custom bundle does not include the `diff` language

§Diff rendering library choice claims:

> `highlight.js` is already bundled (84KB after our custom build). It supports `diff` as a language.

`scripts/build-highlight.js` declares an explicit `LANGUAGES` array: `bash, cpp, csharp, css, glsl, javascript, json, markdown, powershell, python, sql, typescript, xml, yaml`. **`diff` is not in the list.** The runtime bundle will silently fall back to plaintext, so the spec's red/green styling will not happen via `highlight.js` alone.

**Required action:** either add `'diff'` to `LANGUAGES` and rebuild (cheap, do this) or commit to per-line CSS-only styling driven by the leading `+`/`-`/` ` characters (the spec's DOM example already shows `.oe-d-add` / `.oe-d-del` classes, so this is plausibly the actual plan — but then `highlight.js` is irrelevant and the §Diff rendering library choice section is misleading).

---

## IMPORTANT 2 — Dismiss-then-re-add semantics break the "I told it to stop showing me this" intent

§Wire format → "Server drops the entry; future changes to that path will re-add it."

§Use case 1 says the user dismisses a card to signal "this looks wrong, agent please revisit." The agent will then almost certainly edit that file again — and the spec's behavior is to immediately re-surface it. The user's dismiss action and the agent's likely follow-up are on a collision course; the X button effectively does nothing useful in the motivating use case.

This is not a bug in the wire format; it is a UX-semantics decision that the spec leaves implicit. Two coherent options:

1. **Dismiss = "hide until next change"** (current spec): X is a transient acknowledge. Fine if the X is described as such in copy.
2. **Dismiss = sticky until applet reopen / session restart**: matches the user's mental model in use case 1.

Pick one and say so explicitly. The current §Acceptance #4 enshrines the transient option, but the motivating story argues for sticky. The open questions list (#2) only asks "dismiss = also revert?" which is a different axis.

---

## IMPORTANT 3 — `git check-ignore --stdin -v` failure modes are underspecified

§Filter relies on a long-running `git check-ignore --stdin -v` subprocess. Real failure modes the spec does not address:

- The subprocess crashes (OOM, signal, stale git index lock during a concurrent `git checkout`). Spec has no restart/respawn policy. A dead filter means either everything passes (data flood) or everything blocks (silent panel).
- `git check-ignore` returns non-zero for *unignored* paths — the spec's "ask once, cache" loop must handle exit codes 0 (ignored), 1 (not ignored), and 128 (error) distinctly. Without that, the cache may key "not ignored" as "ignored" on a transient error.
- Paths with newlines: `--stdin` is newline-delimited by default; use `-z` and NUL-delimited I/O or filter paths to printable-only. Not in scope to support pathological filenames, but document.
- Concurrent edits during `git checkout` (§Risks acknowledges this case for inotify floods but not for `check-ignore`, which can hang for seconds while the index is locked) — the per-event blocking call will stall the whole edit-stream pipeline.

**Required action:** add a §Failure modes subsection covering subprocess lifecycle (restart on exit, bounded backoff, fail-open vs fail-closed default), exit-code interpretation, and the index-lock interaction.

---

## IMPORTANT 4 — Frontend memory budget is undercounted

§Risks says "Memory growth from 5000-line diffs × 50 cards | ~10MB worst case in browser memory. Acceptable."

That is the raw-string estimate. Actual cost:

- Per-line `<span class="oe-d-...">` wrapping: ~3–5× string size in DOM nodes (each line becomes an Element + Text node + class attribute string).
- `highlight.js` per-token spans on top of that if `diff` lang is added: another 2–3×.
- Layout/paint tree for 250 000 line-spans visible (50 × 5000) measurably blocks the main thread on render; "no virtualization in v1" plus "5000-line truncation cap" plus "50 cards" is incoherent — worst case is 250k DOM nodes in one `.oe-stream`. That is not "acceptable"; that is jank to the point of unresponsiveness on a typical laptop.

**Required action:** either lower the truncation cap (500 lines is plausible for "glance at the diff"), or lower the visible-card cap, or add virtualization to v1 (which §Scroll behavior says is v2). The current three values are mutually inconsistent.

---

## IMPORTANT 5 — Event namespace collision risk

The chosen event name `caco.observable.edit` introduces a new sub-namespace (`caco.observable.*`) for what is really one applet's events. Existing prefixes in `src/` are flat (`caco.usage`, `caco.reload`, `caco.fs.changed`). Either:

- Use `caco.edit` (the spec already names this for the in-process emitter from `dispatch-events.ts`) and route it directly to the applet — drop the `observable.edit` synthetic.
- Or commit to `caco.observable.*` and document why this applet warrants its own namespace.

Naming this as both `caco.edit` (in-process, §Server) **and** `caco.observable.edit` (broadcast, §Wire format) without explaining the split invites future confusion when someone adds a second consumer.

---

## IMPORTANT 6 — Missing open questions

The §Open Questions list is broad but omits the questions whose answers shape the architecture:

1. **Agent-edit diff source**: which of {permission events, detailedContent parsing, compute-on-disk with pre-image cache} do we commit to? (Blocker #1 above.)
2. **Recursive watch**: do we extend `watch-store` or scope-cut filesystem detection? (Blocker #2 above.)
3. **Cross-path coalescing strategy**: per-path vs batched-flush. (Blocker #3 above.)
4. **Pre-image cache eviction**: if we compute diffs on disk, the store must hold pre-images for every tracked path. Cap? Eviction policy? Memory budget?
5. **Filter on absolute paths produced by `sed -i`/external editors**: `check-ignore` needs paths *relative to the repo*; the spec doesn't say where the conversion happens or how to handle paths outside the repo entirely (agent edits a file in `/etc/` — silently drop, or surface unfiltered?).
6. **Session forks**: §Lifecycle doesn't mention what happens when a session is forked. Does the child inherit the lease? Get its own? Lose the panel state? Caco's session-fork model means this needs an explicit answer.

The questions actually listed (auto-scroll default, badge color, X position) are all UI polish that can be decided in a 10-second conversation. The architectural questions above are the ones that should be in the open-questions list.

---

## Checklist summary (11-item)

| # | Item | Status |
|---|---|---|
| 1 | Goal clearly defined | OK |
| 2 | Use cases comprehensive | OK (but use cases 2 & 3 are broken by Blocker 2) |
| 3 | UX clearly defined | Partial — dismiss semantics ambiguous (Important 2), pill-vs-flood unresolved (Blocker 3) |
| 4 | Considerations comprehensive | Gaps: subprocess lifecycle, DOM cost, fork behavior |
| 5 | Code analysis accurate | **Wrong** on SDK shape (Blocker 1), highlight.js bundle (Important 1), `MultiEdit` (Blocker 3) |
| 6 | Risks comprehensive | Missing: filter-subprocess crash, DOM/render cost, recursive-watch requirement |
| 7 | Divisible | Yes — agent-edit and fs-edit are cleanly separable; spec should explicitly stage these |
| 8 | Self-contained for fresh agent | Mostly, but the factually-incorrect SDK and highlight.js claims will mislead an implementer |
| 9 | Avoids transient state | OK |
| 10 | Addresses goal | Partially — Blocker 2 means the "external edits" half of the goal is unimplementable |
| 11 | Edge cases addressed | Significant gaps (see Important 3, Important 6) |

---

## Verdict counts

- **BLOCKER:** 3
- **IMPORTANT:** 6

**Not MVP-ready.** The two core technical claims that the design rests on — "SDK gives us a diff on tool.execution_complete" and "one `dir` lease on `cwd` catches all edits" — are both incorrect against the codebase and the SDK. The spec needs another pass before implementation begins.
