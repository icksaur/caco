# File Edits

> Applet slug: `file-edits`. Successor to `git-status`. Conceptually: **git-status with live updates, collapsible per-file cards, and inline diffs.** Future versions absorb stage / commit / push and the `git-status` applet retires.

## Goal

Let a Caco user watch files change in real-time as the agent (and shell tools, and external editors) modifies them. The motivating use case: VS Code's "agent edits show up as diffs" experience that keeps junior developers in Caco instead of bouncing them to an editor for visibility.

What the user sees: a stacked column of **collapsible** file cards, each with a chevron, the relative path, and an X. By default each card is collapsed — just a header row. Click the chevron to expand and see the diff. Newest at top; new edits auto-scroll the panel into view in v1. One scrollbar for the whole column.

## Non-Goals (v1)

- **Not a text editor.** This is an observer. Editing happens in the agent or in the user's preferred editor on disk.
- **Not stage / commit / push.** v1 is read-only; those stay in the existing `git-status` applet during the transition. They land in v2.
- **Not a tab manager.** v1 ships the stacked view only.
- **Not multi-repo.** v1 scopes to the active session's `cwd`.
- **Not binary diffs.** Files git treats as binary show "(binary file changed, N bytes)" instead of a diff body.
- **Not syntax highlighting on diff content.** v1 ships CSS-only red/green. Per-language token highlighting is v2+.
- **Not full-file textviewer view.** v1 shows `git diff -u` hunk output. The operator wants "full file with diff annotations" (like a text editor that marks changed lines) in v2+ — see §Follow-ups.

## Use Cases

1. **Agent refactor.** Agent is editing 12 files across a refactor. User opens the panel, watches each card appear as the agent works. Cards are collapsed by default; user clicks the ones they want to inspect. When a diff looks wrong, user dismisses (X) and asks the agent to revisit.
2. **External editor.** User opens vim in another window, edits a file. Within a poll cycle, the card appears collapsed.
3. **Shell tool edits.** Agent runs `sed -i s/foo/bar/g src/*.ts`. The git poll catches the multi-file diff on the next cycle; one collapsed card per file.
4. **Long sessions.** Multi-hour refactor; panel must not OOM or jank.

## Design

### Source of truth: git

The user picked git as the source of truth — the right call. Everything that matters in a "what changed?" view, git already tracks: modified files, untracked files, deleted files, renames (with similarity), binary detection, ignored paths. We don't reinvent any of that.

Operationally:

- **Detection:** poll `git status --porcelain=v1 -z` (NUL-delimited, robust against pathological filenames). Default cadence: **1.5s when an active edit-event has fired in the last 10s, 5s otherwise** (idle backoff). On typical repos this is <20ms per call.
- **Diff fetch per file:** `git diff --no-color HEAD -- <path>` for tracked changes; for untracked, read the file directly and synthesize a "+all" diff. Each diff fetch is a single subprocess call, ~10-30ms.
- **Event-accelerated polling:** when the agent emits `tool.execution_complete` for a write tool, OR a file-watch event arrives (if a lease exists), we immediately re-poll instead of waiting for the next tick. This gets the latency under 200ms in the common case without blowing CPU on idle repos. **The operator flagged that v2 wants sub-second responsiveness as a hard goal; v1's event-triggered polling is the foundation for that.**

This means we get **agent edits, shell-tool edits, external-editor edits, sed, anything** for free — git sees them all. No pre-image cache. No SDK permission diff parsing. No recursive fs watcher.

### Card collapse — the canonical UI shape

Per operator: *"Files edited must be discoverable in the UI, but diff details do not need to be."* The card shape:

```
▶ src/foo.ts                              2s   ×
▼ src/bar.ts                              5s   ×
   @@ -10,3 +10,4 @@
   - removed line
   + added line one
   + added line two
     unchanged
```

- Each card starts **collapsed**: just the chevron (▶ / ▼), the relative path, the time-since, and the X button.
- Clicking the chevron (or anywhere in the header row that isn't the X) toggles the body.
- **A re-appearing dismissed-then-revived file appears collapsed.** Sticky dismissal: when the user X's a card and the file is later edited again, the file is silently dropped (sticky). But there's a subtle case: when the user "Reset dismissals" and the file is in the current dirty set, it comes back **collapsed**.
- The body content for v1 is the `git diff -u` hunk output with `+`/`-` lines red/green. v2 evolves toward "full file with diff annotations" — see §Follow-ups.

### Auto-scroll (v1: always; v2: sticky)

Per operator override: **v1 always auto-scrolls** so the newest card is visible. Simple and easy.

v2 introduces "stick when scrolled away": detect scroll position, suppress auto-scroll when user is reading earlier cards, show a floating "↓ new edits below" button when off-screen content appears. v1 is dumb-but-useful; v2 is smart.

### Why this is better than the v2 spec

The v2 spec was going to:
- maintain a pre-image cache (memory, eviction, races)
- parse SDK permission events for diffs (fragile, only fires under permission prompting)
- limit to agent-only (loses 2 of 4 use cases)
- duplicate everything git already computes

Asking git directly collapses all of that to: poll → diff → emit.

### Future: replace `git-status` applet

**Reversed 2026-06-01.** Originally framed as the successor to
`git-status`. Operator decided V3 keeps file-edits as a read-only
viewer; git-status stays as a separate applet for stage/commit/push.
The "block commit while reviewing" behavior may still ship, but as
a small server-side lease the git-status applet observes.

### Filesystem watch as accelerator (optional, v1)

When the panel is open, acquire a file-watch lease per **distinct directory** that currently has dirty files. Since `git status` already gives us that list cheaply, we know exactly which directories to watch — no recursion needed.

- Compute the set of dirs from the last `git status` result.
- Diff against currently-leased dirs; acquire new leases, release stale ones.
- Cap at 12 leases (leaves headroom in the 16-process budget).
- On `caco.fs.changed` for any leased dir, schedule an immediate poll (debounced 50ms).

If we hit the 12-dir cap (huge repo, many touched dirs), drop the accelerator entirely and fall back to pure timer polling. Functional degradation only; the panel still works.

This is the **only** time we use fs watching, and it never tries to be recursive.

### Coalescing

Each `git status` poll produces a snapshot. We diff snapshots:
- new path in dirty set → fetch diff, emit.
- path missing from dirty set but was present → emit "(cleared — file matches HEAD)" so the card auto-removes.
- path present in both with different mtime/hash → fetch fresh diff, emit.

A poll produces one broadcast carrying the full delta as an `edits[]` array, regardless of how many files changed. Cross-path batching is automatic — no explicit window needed.

### Commit-lease blocker (operator requirement, deferred to v2)

> "Eventually this applet should prevent git commit while there is an active lease, so that the user can accept all at once."

Mechanism (v2): when the panel is open, the applet holds a **commit lease**. The git-status applet (or any tool that runs `git commit`) checks for active commit leases before letting the commit proceed; if blocked, surfaces an "open in file-edits, dismiss what you want excluded, then commit" prompt.

For v1, scope: just track the lease; don't actually block commits. We need the data model so v2's blocker is trivial.

### Wire format

```ts
// Broadcast to the originating session:
{
  type: 'caco.edit',
  data: {
    edits: Array<{
      path: string;            // absolute
      relativePath: string;    // relative to repo root
      diff: string;            // unified diff (`git diff` output)
      status: 'modified' | 'untracked' | 'deleted' | 'renamed';
      renamedFrom?: string;    // when status === 'renamed'
      isBinary?: boolean;      // body is summary line if true
      timestamp: string;
      truncated?: { hiddenLines: number };
    }>;
    cleared: string[];         // relative paths that returned to HEAD; applet removes their cards
    pollSource: 'timer' | 'event';
  }
}
```

One event type: `caco.edit`. Flat `caco.*` namespace, consistent with `caco.usage`, `caco.fs.changed`, etc.

### Dismiss semantics

**Sticky until applet restart or "Reset dismissals".** When the user X's a card, the path joins client-side `dismissedPaths: Set<string>`. Future `caco.edit` entries for that path are filtered at the applet level. Server has no idea about dismissals.

Toolbar:
- **`+`** — open a fuzzy file picker (V3.1). Adds the picked file as a card.
- **Reset dismissals** — clears the dismiss set; previously dismissed files reappear (collapsed) if still in the dirty set.
- **Counts** — N files modified / N dismissed.

### Resource limits

- **Visible card cap:** 50. Oldest dropped on overflow.
- **Per-diff line cap:** 1000 lines. Diffs larger show "(truncated — N lines hidden)" with a link to `text-editor` for the full file.
- **Cards collapsed by default** means the DOM cost is mostly the headers — only expanded cards pay the per-line cost. Worst case (every card expanded with 1000-line diff): 50 × 1000 × ~3 spans ≈ 150k nodes. Realistic case (5 expanded): ~15k nodes. Collapse is the load-bearing optimization.
- **`git diff` per-file timeout:** 2s. Beyond that, show "(diff timed out)".
- **No pre-image cache.** Git is the cache.

### Filter

Git's index already excludes ignored paths from `git status`. Untracked-but-not-ignored shows up. `.gitignore` is the filter — exactly what the user expects. No extra filter logic in v1.

For repos without git (any session in a non-repo cwd), the panel shows "Not a git repo — file-edits requires git for v1" and doesn't poll. Future: extension blacklist fallback for non-git cases.

### Client: `applets/file-edits/`

Standard Caco applet (meta.json, content.html, script.js, style.css).

DOM shape:

```html
<div class="fe-root">
  <div class="fe-toolbar">
    <span class="fe-repo">caco</span>
    <span class="fe-counts">12 files · 0 dismissed</span>
    <button class="fe-open" title="Open file">+</button>
    <button class="fe-reset">Reset dismissals</button>
  </div>
  <div class="fe-stream">
    <article class="fe-card" data-path="src/foo.ts" data-expanded="false">
      <header class="fe-card-head">
        <button class="fe-chevron" aria-label="Toggle">▶</button>
        <code class="fe-path">src/foo.ts</code>
        <time class="fe-time">2s</time>
        <button class="fe-x" aria-label="Dismiss">×</button>
      </header>
      <pre class="fe-diff" hidden>
        <span class="fe-d-add">+ new line</span>
        <span class="fe-d-del">- old line</span>
        <span class="fe-d-ctx">  unchanged</span>
      </pre>
    </article>
  </div>
</div>
```

Behavior:
- Subscribes to `caco.edit` via `appletAPI.onEvent`.
- Maintains `Map<path, cardElement>`. New path → prepend card (newest at top), collapsed. Same path → replace diff content in place, bump time, **keep current expand state**. Path in `cleared[]` → remove card.
- Chevron / header click: toggle `[hidden]` on `.fe-diff`, update chevron glyph.
- X button: add to `dismissedPaths`, remove card.
- **v1: always scroll-to-top on new card insertion** (operator override).

### Diff styling

Per-line CSS classes driven by leading `+` / `-` / ` ` characters, applied during diff parsing. No reliance on `highlight.js` for the diff structure itself in v1.

Per-language syntax highlighting (e.g. TypeScript inside the diff body) is v2+. Operator explicitly deferred this.

### Server module: `src/git-edit-poller.ts`

Per-session state (or per-repo-root, shared across sessions on the same cwd):

```ts
interface GitEditPoller {
  attachToSession(sessionId: string, cwd: string): void;
  detachFromSession(sessionId: string): void;
  triggerPoll(sessionId: string, source: 'event'): void;
}
```

The poller:
- Spawns one `git status --porcelain=v1 -z` per tick (long-running subprocesses are tempting but `git status` is fast and stateless; one-shot is simpler).
- Diffs the dirty-set against the last snapshot.
- For each new/changed path, spawns `git diff --no-color HEAD -- <path>` (or reads untracked).
- Broadcasts `caco.edit` with the delta.

Triggered from three places:
1. Internal timer (1.5s active / 5s idle).
2. SDK `tool.execution_complete` for write tools (via dispatch-events forwarding).
3. `caco.fs.changed` from any accelerator lease.

All three converge on `triggerPoll`, which debounces (50ms) so multiple triggers in flight produce one poll.

### Lifecycle

- Session created/resumed → poller attaches if `cwd` is a git repo.
- Applet opens → no special handshake; poller is already running. The applet **immediately requests a full snapshot** via `POST /api/sessions/:id/file-edits/snapshot` to populate the panel with current state.
- Applet closes → no server-side change. (Future: drop accelerator leases if no applet is observing.)
- Session ends → poller detaches; cleanup.

### Code Analysis

#### Files added

| File | Lines (est) |
|------|---|
| `src/git-edit-poller.ts` | ~250 |
| `src/routes/file-edits.ts` | ~50 (snapshot endpoint) |
| `applets/file-edits/meta.json` | ~30 |
| `applets/file-edits/content.html` | ~25 |
| `applets/file-edits/script.js` | ~250 |
| `applets/file-edits/style.css` | ~160 |
| `tests/unit/git-edit-poller.test.ts` | ~180 |

#### Files modified

| File | What |
|------|---|
| `src/dispatch-events.ts` | On `tool.execution_complete` for write tools, call `gitEditPoller.triggerPoll(sessionId, 'event')`. |
| `src/routes/index.ts` | Mount new router. |
| `server.ts` | Instantiate `gitEditPoller`, attach to sessionState lifecycle. |

No new npm dependencies. `git` is assumed; `child_process.spawn` is built-in. No `highlight.js` change in v1.

## Considerations

### Why polling, not "agent edit events as primary"?

The user said git is the source of truth. Following that literally: ask git. Polling at 1.5s is cheaper than the engineering of pre-image cache + permission event parsing + race handling — and works for every source of edits, not just agent.

### Polling cost

`git status --porcelain` is one of git's most-optimized commands. On a clean repo, it's <5ms. On a dirty 10-file working tree, ~10-20ms. On a huge repo (linux kernel), ~50-100ms. We're well inside acceptable for a 1.5s cadence.

### What about `git --watch`?

Doesn't exist. There are git's internal `core.fsmonitor` and watchman integration, but they're opt-in and complex. v1 skips; v2 evaluates if "sub-second responsiveness" demands it.

### Renames

`git status --porcelain` reports renames as `R old -> new` with similarity scoring (default 50%). We pass the from-path in `renamedFrom`. Applet shows a single card with a "renamed" status badge.

### Binary files

`git diff` detects binary files and emits "Binary files X and Y differ". We pass `isBinary: true` and skip the diff body; card shows `"(binary file changed — N bytes)"` and the chevron is disabled.

### Deleted files

Status `D` (deleted from working tree). We show a card with a "deleted" badge and the diff body = the entire previous content as deletions (clip to 1000 lines).

### Untracked files

Status `??`. We synthesize the diff: `--- /dev/null` / `+++ <path>` followed by the file content as `+` lines. Subject to the 1000-line cap and the binary check.

### Performance: detection vs diff fetch

`git status` is one process; full diff requires N spawns. We minimize:
- Only diff the **delta** between snapshots, not every dirty file every tick.
- Skip diff fetch if `git status` says the file's mtime hasn't changed since last seen.
- Coalesce: a poll triggered by multiple events in 50ms only runs once.

### When the agent edits a binary file

Untracked binary new file → "(binary file added — N bytes)". The applet still cares (file changed) but doesn't pretend to diff.

### Commit-lease v1 stub

The poller exports `hasActiveLeases(repoRoot)` and the applet calls `POST /file-edits/lease` on open / `DELETE` on close. v1 doesn't *use* the lease to block anything yet; we just track it. v2 wires it into git-status's commit button.

### Concurrent sessions on same repo

Two sessions with the same cwd → two pollers ticking against the same repo. Wasteful but harmless. v2: poller is per-repo-root (not per-session); subscribers fan out from one source.

### What if the user runs `git checkout`?

50 files appear dirty, then disappear. We emit one broadcast with 50 new edits, then on the next tick after checkout completes, a broadcast with 50 in `cleared[]`. The applet handles the churn (caps at 50 visible, cards auto-remove on clear). Operator confirmed: "natural churn is fine."

### Diff styling

CSS-class-driven (`+` → `.fe-d-add`, `-` → `.fe-d-del`, ` ` → `.fe-d-ctx`).

## Risks

| Risk | Likelihood | Mitigation |
|------|---|---|
| `git status` slow on huge repo | Low-Medium | Idle backoff (5s when nothing changed); fsmonitor / watchman integration is a v2 lever |
| All cards expanded = 150k DOM nodes | Low | Cards default collapsed; user-driven expansion is the throttle. If a real user manages to OOM by expanding 50 cards × 1000 lines, drop visible cap to 30 |
| Long-running `git diff` blocks the poller | Low | 2s timeout per `git diff`; show "(diff timed out)" in the card |
| Untracked file is huge | Medium | Same 1000-line truncation; show "(truncated)" |
| User has commit in flight when poll runs and sees half-applied state | Low | git's index is atomic during commit; worst case is one stale poll |
| Polling cost on extremely active repos (CI logs being written) | Medium | gitignore + idle backoff; if still bad, switch to git fsmonitor |
| Accelerator lease cap (12 dirs) exceeded | Low | Document; falls back to pure timer polling, panel still works |
| Two sessions both polling the same cwd | Low | Wasted CPU but correct. v2 dedup. |
| Operator's commit-lease idea not yet implemented | Medium | v2; v1 stubs the tracking so the v2 wiring is trivial |
| Auto-scroll-always disrupts user reading earlier cards | High | Acknowledged tradeoff; operator chose simplicity. v2 sticks when scrolled. |
| `git status -z` parsing edge cases | Low | NUL-delimited is robust; test with paths containing spaces and quotes |

## Acceptance (v1)

1. Open session in a git repo with no dirty files. Open `file-edits` applet. Panel shows "No changes." Within 200ms.
2. Agent calls `edit` on a file. Within ~1.5s (or sooner if event-triggered), a **collapsed** card appears with chevron, path, time, X.
3. Click the chevron. Diff body expands with red/green styling. Click again to collapse.
4. Agent edits 10 files in 500ms. Next poll batches all 10 into one `caco.edit` broadcast; applet renders 10 collapsed cards in one batch. Panel auto-scrolls to top.
5. User runs `vim other-file.ts` outside Caco, saves. Within 1.5-5s (depending on backoff), a collapsed card appears.
6. Agent runs `git checkout main` (50 files churn). Panel shows 50 collapsed cards, then 50 cards clear on the next tick.
7. Click X on a card → card disappears. Subsequent edits to that path do NOT re-add.
8. Click "Reset dismissals" → previously-dismissed files in the current dirty set reappear, collapsed.
9. Click `+` → fuzzy file picker opens; pick a file → card appears.
10. Open the applet on a non-git cwd → see "Not a git repo" message; no polls run.
11. New untracked file → collapsed card with "(untracked)" badge; expanded view shows full content as additions.
12. File deleted → collapsed card with "deleted" badge; expanded view shows previous content as deletions.
13. Binary file changed → card shows "(binary file changed — N bytes)"; chevron disabled.
14. Session ends → poller detaches; no leaked subprocesses.

## V2 scope (locked)

Five items, ordered by operator priority. Anything not listed here is V3.

1. **Full-file textviewer diff.** Replace v1's hunk-format `git diff -u` with a whole-file view: unchanged lines muted gray, added lines green, removed lines red — like a text editor with diff annotations. Fetch HEAD + working tree, render unified line-by-line. Reachable from card header (e.g. click path = expand to full-file mode); collapsed/hunk view remains default for the stacked feed.
2. **Per-language syntax highlighting** inside diff bodies. Highlight.js is already vendored — bundle the language pack and `'diff'` mode, detect language from extension, apply to each line span without breaking the per-line red/green class.
3. **Word-level intra-line diff.** For each `-`/`+` line pair, highlight the changed tokens rather than coloring the whole line. Use a diff-match-patch-style word tokenization; render `<mark>` spans inside the line.
4. **Sticky auto-scroll.** v1 always pins to top on any change. v2: if the user has scrolled away from top, leave them alone and show a "↓ new edits" affordance; if they're at top, keep following.
5. **Side-by-side toggle** for files above a size threshold. Split-pane red/green columns. Per-card toggle in the header; remembers preference per session.

### V2 non-goals

Explicit V2 non-goals (deferred to V3 — see backlog below):

- Stage / unstage / commit / push (git-status replacement).
- Commit-lease enforcement.
- `git fsmonitor` integration.
- Server-side per-path hashing / mtime gating.
- Multi-source signals beyond git.
- Keyboard navigation, filter bar, file tree sidebar.
- Editor jump-out (`vscode://`).
- Image / binary previews.
- Conflict-marker awareness.
- Per-repo shared poller, multi-repo views.
- Replay buffer for pre-open edits beyond the existing snapshot.

## V3 backlog (deferred — do not pull into V2)

Captured for record; no commitment, no ordering until V2 ships.

**Direction shift (2026-06-01, operator):**

> "This is useful enough that I'm not sure it should be only for diffs
> and I don't think I want it to replace the git-status applet."

So the applet's V3 identity is **a stacked read-only file viewer** that
happens to highlight diffs when present, NOT a git-status replacement.
git-status stays as a separate applet for stage/commit/push flows.
file-edits's V3 direction is file navigability + viewer polish; the
stage/commit/discard items are explicitly removed from this backlog.

### File navigability (operator priority, 2026-06-01)

The applet stacks files modified by the agent or by user tools. It does
not currently support browsing the repo or pinning files of interest.
Goal: turn it into a competent read-only viewer with persistence.

- **Open arbitrary file (no edit required).** Dropdown / file picker /
  "+" button that adds any path in the repo to the stacked view as a
  clean card with full HEAD content. The card persists like any other.
  This is the largest single feature on the V3 list.
- **Per-card pin.** Opposite of dismiss; "keep this card even if cap
  eviction would otherwise drop it." Pinned cards are also exempt from
  the 50-card cap counting.
- **Reveal-in-tree sidebar.** File-tree view of the repo (or a filtered
  view of the dirty set) for click-to-add.
- **Per-card jump-to-editor** (`vscode://file/...`). Open the path in
  the user's external editor.
- **Collapse-all / Expand-all toolbar buttons.** Bulk control once
  card counts get high.
- **Filter bar** — by path glob, by status, by "touched in last N
  minutes."
- **Stale persisted-card cleanup** — a path persisted from yesterday
  that's now deleted from HEAD renders an empty-body card forever.
  Auto-prune or surface a "stale" badge with a one-click dismiss.

### Polling and responsiveness

- **git fsmonitor integration** for sub-second updates. Replaces the
  1.5s/5s polling loop. The user-facing win is detecting edits made
  outside the agent (in VSCode, in the shell) in <1s rather than 1.5s.
- **chokidar fallback / supplement** — simpler than fsmonitor; watch
  the repo root with `.gitignore` filtering as a stopgap before
  fsmonitor.
- **Server-side per-path hash + porcelain v2 mtime gating** to skip
  `git diff` subprocess on no-op polls. Reduces server load; complements
  fsmonitor.
- **Per-repo shared poller** across sessions on the same cwd. Today
  each session polls independently.
- **Multi-source signals** — surface agent `edit`/`create`/`write` tool
  hooks distinctly from git-dirty, with a decay badge for "just touched
  by agent." Helps spot churn the agent did and immediately reverted.

### Display fidelity

- **Color/contrast pass on diff rows** — operator-reported (2026-05-31).
  Partially addressed (bright-text fix on word marks, opacity cleanup
  on ctx rows), but some hljs tokens on the 18% row tint may still need
  systematic tuning across the full hljs-dark palette.
- **Side-by-side / split-pane diff view** — operator-deferred from V2.
  Two columns (HEAD | working tree) for files above a width/size
  threshold; per-card toggle.
- **Word-level diff polish** — consider switching to a `<ins>`/`<del>`
  shape instead of `<mark>` for semantic correctness; current fix is
  visual-only.
- **Binary image preview** (before/after thumbnails) for images.
- **Conflict-marker awareness** — distinct status for files containing
  `<<<<<<<` merge markers.
- **Truncation "show more"** instead of silent cap on large diffs.
- **Cross-applet shared "code body" stylesheet** — file-edits is on
  Caco design tokens (`--text-sm`, `--font-mono`); text-editor still
  uses hardcoded `pt` units. Migrate text-editor onto the same tokens,
  or extract a shared `code.css` referenced by both applets.

### Non-goals (V3 explicitly NOT this)

Operator (2026-06-01): the applet stays a read-only viewer. The
following items are explicitly OUT of scope for V3; they belong to
git-status or its successor, not here.

- Stage / unstage per file or per hunk.
- Commit composer (subject/body/co-author toggle).
- Push, pull, fetch.
- Discard file or hunk.
- Commit lease (block agent-initiated `git commit` while reviewing).
  May still ship as a small server-side helper, but the UI lives in
  git-status.

### Input

- **Keyboard navigation** — j/k between cards, e expand, x dismiss,
  Enter open-in-text-editor, / focus filter bar.

### Other

- **Untracked-ignored toggle** for `.gitignore`'d paths the agent
  wrote (build artifacts).
- **Persistence migration** — schemaVersion 1 only today; future field
  additions need a forward-compat path beyond "drop unknown."
- **Persistence reconciliation** — when the JSON file accumulates stale
  entries (e.g. user dismissed many over a long session), the snapshot
  slices to the cap and the rest become orphans on disk. Trim on
  load, or expose a "compact" action.
- **Replay buffer** for edits prior to applet open beyond what
  snapshot covers (currently snapshot fills cleanly for persisted-
  clean, but transient mid-edit states between snapshot and first
  `caco.edit` are lost).


## Operator-decided defaults (post-questionnaire)

All 10 architectural questions answered. Locked-in for v1:

- **Source of truth: git.** Polling-based detection. Confirmed.
- **Name: `file-edits`.** Successor to git-status.
- **Commit-lease blocker: v2.** v1 stubs the data model only.
- **Poll cadence: 1.5s active / 5s idle.** Event-triggered immediate polls. v2 goal: sub-second responsiveness.
- **Cards: 50 visible × 1000 line truncation.** v2 evolves to full-file textviewer diff with syntax highlighting.
- **Dismiss: sticky.** Returns collapsed if "Reset dismissals" is clicked.
- **Newest at top.**
- **Auto-scroll: v1 always.** v2 adds sticky + reveal button.
- **Non-git cwd: "Not a git repo" message, no fallback in v1.**
- **`git checkout` churn: handle naturally.**


