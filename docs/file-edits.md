# File Edits

> Applet slug: `file-edits`. Successor to `git-status`. Conceptually: **git-status with live updates and inline stacked diffs.** Future versions absorb stage / commit / push and the `git-status` applet retires.

## Goal

Let a Caco user watch files change in real-time as the agent (and shell tools, and external editors) modifies them. The motivating use case: VS Code's "agent edits show up as diffs" experience that keeps junior developers in Caco instead of bouncing them to an editor for visibility.

What the user sees: a stacked column of file cards, each with the relative path and an X. Below each filename, a syntax-highlighted unified diff (red/green). One scrollbar for the whole column. Cards appear, update, and dismiss as files change.

## Non-Goals (v1)

- **Not a text editor.** This is an observer. Editing happens in the agent or in the user's preferred editor on disk.
- **Not stage / commit / push.** v1 is read-only; those stay in the existing `git-status` applet during the transition. They land in v2 of this applet.
- **Not a tab manager.** v1 ships the stacked view only.
- **Not multi-repo.** v1 scopes to the active session's `cwd`.
- **Not binary diffs.** Files git treats as binary show "(binary file changed, N bytes)" instead of a diff body.

## Use Cases

1. **Agent refactor.** Agent is editing 12 files across a refactor. User opens the panel, watches each diff appear in real time. When a diff looks wrong, user dismisses (X) and asks the agent to revisit. When all looks good, user moves to `git-status` to stage + commit.
2. **External editor.** User opens vim in another window, edits a file. Within a poll cycle, the card appears with `source: fs`.
3. **Shell tool edits.** Agent runs `sed -i s/foo/bar/g src/*.ts`. The git poll catches the multi-file diff on the next cycle.
4. **Long sessions.** Multi-hour refactor; panel must not OOM or jank.

## Design

### Source of truth: git

The user picked git as the source of truth — the right call. Everything that matters in a "what changed?" view, git already tracks: modified files, untracked files, deleted files, renames (with similarity), binary detection, ignored paths. We don't reinvent any of that.

Operationally:

- **Detection:** poll `git status --porcelain=v1 -z` (NUL-delimited, robust against pathological filenames). Default cadence: 1.5s when an active edit-event has fired in the last 10s, 5s otherwise (idle backoff). On typical repos this is <20ms per call.
- **Diff fetch per file:** `git diff --no-color HEAD -- <path>` for tracked changes; for untracked, read the file directly and synthesize a "+all" diff. Each diff fetch is a single subprocess call, ~10-30ms.
- **Event-accelerated polling:** when the agent emits `tool.execution_complete` for a write tool, OR a file-watch event arrives (if a lease exists), we immediately re-poll instead of waiting for the next tick. This gets the latency under 200ms in the common case without blowing CPU on idle repos.

This means we get **agent edits, shell-tool edits, external-editor edits, sed, anything** for free — git sees them all. No pre-image cache. No SDK permission diff parsing. No recursive fs watcher.

### Why this is better than the v2 spec

The v2 spec was going to:
- maintain a pre-image cache (memory, eviction, races)
- parse SDK permission events for diffs (fragile, only fires under permission prompting)
- limit to agent-only (loses 2 of 4 use cases)
- duplicate everything git already computes

Asking git directly collapses all of that to: poll → diff → emit.

### Future: replace `git-status` applet

Once `file-edits` reaches feature parity (stage all, unstage, stage hunk, commit, push, pull), the existing `git-status` applet retires. The "active leases block commit" behavior (operator requirement, see below) lives natively here, not bolted on across two applets.

### Filesystem watch as accelerator (optional)

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
    pollSource: 'timer' | 'event' | 'manual-refresh';
  }
}
```

One event type: `caco.edit`. Flat `caco.*` namespace, consistent with `caco.usage`, `caco.fs.changed`, etc.

### Dismiss semantics

**Sticky until applet restart or "Reset dismissals".** When the user X's a card, the path joins client-side `dismissedPaths: Set<string>`. Future `caco.edit` entries for that path are filtered at the applet level. Server has no idea about dismissals.

This matches the motivating use case: "I told it to stop showing me this file."

Toolbar:
- **Refresh** — manual poll trigger.
- **Reset dismissals** — clears the dismiss set.
- **Counts** — N files modified / N dismissed.

### Resource limits

- **Visible card cap:** 50. Oldest dropped on overflow. (Operator preference from notes: bigger than 30 to handle larger refactors.)
- **Per-diff line cap:** 1000 lines. Diffs larger show "(truncated — N lines hidden)" with a link to `text-editor` for the full file.
- **Worst-case DOM:** 50 × 1000 × ~3 spans/line ≈ 150k nodes. Borderline; if jank shows up in testing, drop to 30 visible.
- **`git diff` per-file timeout:** 2s. Beyond that, show "(diff timed out)".
- **No pre-image cache.** Git is the cache.

### Filter

Git's index already excludes ignored paths from `git status`. Untracked-but-not-ignored shows up. `.gitignore` is the filter — exactly what the user expects. No extra filter logic in v1.

For repos without git (any session in a non-repo cwd), the panel shows "Not a git repo — file-edits requires git for v1" and doesn't poll. Future: extension blacklist fallback for non-git cases.

### Client: `applets/file-edits/`

Standard Caco applet. Standard structure (meta.json, content.html, script.js, style.css).

DOM shape:

```html
<div class="fe-root">
  <div class="fe-toolbar">
    <span class="fe-repo">caco</span>
    <span class="fe-counts">12 files · 0 dismissed</span>
    <button class="fe-refresh">↻</button>
    <button class="fe-reset">Reset dismissals</button>
  </div>
  <div class="fe-stream">
    <article class="fe-card" data-path="src/foo.ts">
      <header>
        <span class="fe-status fe-status-modified">M</span>
        <code class="fe-path">src/foo.ts</code>
        <time class="fe-time">2s</time>
        <button class="fe-x" aria-label="Dismiss">×</button>
      </header>
      <pre class="fe-diff">
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
- Maintains `Map<path, cardElement>`. New path → prepend card (newest at top). Same path → replace diff content in place, bump time. Path in `cleared[]` → remove card.
- X button: add to `dismissedPaths`, remove card.
- "↑ N new" floating pill when cards arrive above the viewport.

### Server module: `src/git-edit-poller.ts`

Per-session state (or per-repo-root, shared across sessions on the same cwd):

```ts
interface GitEditPoller {
  attachToSession(sessionId: string, cwd: string): void;
  detachFromSession(sessionId: string): void;
  triggerPoll(sessionId: string, source: 'event' | 'manual-refresh'): void;
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
- Applet opens → no special handshake; poller is already running. The applet just subscribes to `caco.edit` and **immediately requests a full snapshot** via `POST /api/sessions/:id/file-edits/snapshot` to populate the panel with current state. (This solves the v2 spec's "no replay on open" problem trivially — git always tells us current state.)
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
| `applets/file-edits/script.js` | ~220 |
| `applets/file-edits/style.css` | ~140 |
| `tests/unit/git-edit-poller.test.ts` | ~180 |

#### Files modified

| File | What |
|------|---|
| `src/dispatch-events.ts` | On `tool.execution_complete` for write tools, call `gitEditPoller.triggerPoll(sessionId, 'event')`. |
| `src/routes/index.ts` | Mount new router. |
| `server.ts` | Instantiate `gitEditPoller`, attach to sessionState lifecycle. |
| `scripts/build-highlight.js` | Add `'diff'` to LANGUAGES (~5KB). |

No new npm dependencies. `git` is assumed; `child_process.spawn` is built-in.

## Considerations

### Why polling, not "agent edit events as primary"?

The user said git is the source of truth. Following that literally: ask git. Polling at 1.5s is cheaper than the engineering of pre-image cache + permission event parsing + race handling — and works for every source of edits, not just agent.

### Polling cost

`git status --porcelain` is one of git's most-optimized commands. On a clean repo, it's <5ms. On a dirty 10-file working tree, ~10-20ms. On a huge repo (linux kernel), ~50-100ms. We're well inside acceptable for a 1.5s cadence.

### What about `git --watch`?

Doesn't exist. There are git's internal `core.fsmonitor` and watchman integration, but they're opt-in and complex. Skip; the polling cost is fine.

### Renames

`git status --porcelain` reports renames as `R old -> new` with similarity scoring (default 50%). We pass the from-path in `renamedFrom`. Applet shows a single card with a "renamed" status badge.

### Binary files

`git diff` detects binary files and emits "Binary files X and Y differ". We pass `isBinary: true` and skip the diff body; card shows `"(binary file changed — N bytes)"`.

### Deleted files

Status `D` (deleted from working tree). We show a card with a "deleted" badge and the diff body = the entire previous content as deletions (clip to 1000 lines like any other diff).

### Untracked files

Status `??`. We synthesize the diff: `--- /dev/null` / `+++ <path>` followed by the file content as `+` lines. Subject to the 1000-line cap and the binary check.

### Performance: detection vs diff fetch

`git status` is one process; full diff requires N spawns. We minimize:
- Only diff the **delta** between snapshots, not every dirty file every tick.
- Skip diff fetch if `git status` says the file's mtime hasn't changed since last seen (mtime in porcelain v2; v1 doesn't carry it — may upgrade to v2 if needed).
- Coalesce: a poll triggered by multiple events in 50ms only runs once.

### When the agent edits a binary file

Untracked binary new file → "(binary file added — N bytes)". The applet still cares (file changed) but doesn't pretend to diff.

### Commit-lease v1 stub

The poller exports `hasActiveLeases(repoRoot)` and the applet calls `POST /file-edits/lease` on open / `DELETE` on close. v1 doesn't *use* the lease to block anything yet; we just track it. v2 wires it into git-status's commit button.

### Concurrent sessions on same repo

Two sessions with the same cwd → two pollers ticking against the same repo. Wasteful but harmless. v2: poller is per-repo-root (not per-session); subscribers fan out from one source.

### What if the user runs `git checkout`?

50 files appear dirty, then disappear. We emit one broadcast with 50 new edits, then on the next tick after checkout completes, a broadcast with 50 in `cleared[]`. The applet handles the churn (caps at 50 visible, cards auto-remove on clear). No special handling needed.

### Diff styling

CSS-class-driven (`+` → `.fe-d-add`, `-` → `.fe-d-del`, ` ` → `.fe-d-ctx`). Adding `'diff'` to highlight.js gives per-token coloring inside hunks. Both work.

## Risks

| Risk | Likelihood | Mitigation |
|------|---|---|
| `git status` slow on huge repo | Low-Medium | Idle backoff (5s when nothing changed); fsmonitor / watchman integration is a v2 lever |
| 50 cards × 1000 lines = 150k DOM nodes | Medium | Borderline; if jank shows in real use, drop visible cap to 30 |
| Long-running `git diff` blocks the poller | Low | 2s timeout per `git diff`; show "(diff timed out)" in the card |
| Untracked file is huge | Medium | Same 1000-line truncation; show "(truncated)" |
| User has commit in flight when poll runs and sees half-applied state | Low | git's index is atomic during commit; worst case is one stale poll |
| Polling cost on extremely active repos (CI logs being written) | Medium | gitignore + idle backoff; if still bad, switch to git fsmonitor |
| Accelerator lease cap (12 dirs) exceeded | Low | Document; falls back to pure timer polling, panel still works |
| Two sessions both polling the same cwd | Low | Wasted CPU but correct. v2 dedup. |
| Operator's commit-lease idea not yet implemented | Medium | v2; v1 stubs the tracking so the v2 wiring is trivial |
| `git rename` heuristic detects spurious renames | Low | Cosmetic; show the badge but the diff is still right |
| Card pinning to top while user scrolls down | Medium | "↑ N new" pill default; no auto-scroll |
| `git status -z` parsing edge cases | Low | NUL-delimited is robust; test with paths containing spaces and quotes |

## Acceptance (v1)

1. Open session in a git repo with no dirty files. Open `file-edits` applet. Panel shows "No changes." Within 200ms.
2. Agent calls `edit` on a file. Within ~1.5s (or sooner if event-triggered), card appears with red/green diff.
3. Agent edits 10 files in 500ms. Next poll batches all 10 into one `caco.edit` broadcast; applet renders 10 cards in one batch.
4. User runs `vim other-file.ts` outside Caco, saves. Within 1.5-5s (depending on backoff), card appears.
5. Agent runs `git checkout main` (50 files churn). Panel handles the burst, then 50 cards clear on the next tick.
6. Click X on a card → card disappears. Subsequent edits to that path do NOT re-add.
7. Click "Reset dismissals" → dismiss set clears.
8. Click "Refresh" → manual poll fires immediately.
9. Open the applet on a non-git cwd → see "Not a git repo" message; no polls run.
10. Open in a 1000-file dirty repo (e.g. mid-refactor) → snapshot endpoint returns first 50; rest accessible via per-file fetch in v2.
11. New untracked file → card shows full content as additions, "(untracked)" badge.
12. File deleted → card shows full content as deletions, "deleted" badge.
13. Binary file changed → card shows "(binary file changed — N bytes)", no diff body.
14. Session ends → poller detaches; no leaked subprocesses.

## Follow-ups (not v1, in priority order)

1. **v2 = git-status replacement.** Add stage / unstage / commit / push / pull. Retire the existing `git-status` applet.
2. **Commit lease enforcement.** When the panel is open with active changes, git commit (from anywhere in Caco — the new applet's button, the old applet's button, the agent running `git commit`) checks for active leases and prompts to acknowledge.
3. **Hunk-level approve / reject.** Per-hunk buttons; reject = `git checkout -p` for that hunk.
4. **Per-repo poller** (one process tick shared across sessions on same cwd).
5. **`git fsmonitor` integration** for huge repos.
6. **Replay buffer** for cards that arrived before applet opened (already partly solved by snapshot endpoint).
7. **Multi-repo / multi-cwd.**
8. **Word-level diff.**
9. **Tabbed view A/B.**
10. **Image-viewer hand-off** for binary changes that are images.

## Open questions (architectural; will leave in spec until you confirm)

These weren't explicitly answered in the questionnaire (no `changes` were written through the surface):

1. **Poll cadence.** 1.5s active / 5s idle proposed. Real-time-ish but not chatty. Tunable.
2. **Visible card cap.** 50 (was 30 in v2 spec; bumped per intuition that real refactors hit >30). Worth testing.
3. **Newest position.** Top (notification-style) or bottom (build-log style). Spec proposes top.
4. **Auto-scroll on new card.** Off by default; "↑ N new" pill at top. Spec proposes that.
5. **Diff truncation cap.** 1000 lines. Tunable.
6. **Accelerator-lease cap.** 12 dirs (out of 16 process cap). Tunable.
7. **Snapshot on open.** Confirmed yes per "git is source of truth" — git tells us current state any time we ask.

Conclude these whenever; safe to ship v1 with the proposed defaults.
