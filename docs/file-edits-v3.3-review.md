# File Edits V3.3 — Spec Review

Reviewed against: `docs/file-edits-v3.3.md` (spec), `src/git-edit-poller.ts`,
`src/watch-store.ts`, `docs/file-watch-leases.md`, `docs/file-edits-v3.2.md`,
`src/routes/api.ts:472`, chokidar README (current).

**Finding counts: 3 BLOCKER · 6 IMPORTANT · 3 NICE · 3 QUESTION**

---

## [BLOCKER] `triggerPoll` AND `pollSession` both need type changes; spec only mentions one

**Files:** `src/git-edit-poller.ts:340`, `:446`, `:548`, `:555`

The public interface at line 340 is:
```ts
triggerPoll(sessionId: string, source: 'event'): void;
```
The implementation at line 548 mirrors it. V3.3 calls
`triggerPoll(sessionId, 'fs-event')` — fails TS compilation at the call site.

The spec says "triggerPoll gains a new source `'fs-event'`" but doesn't flag
updating the interface literal. That alone is fixable. The harder gap: at line 555,
`triggerPoll`'s debounce callback does
`pollSession(sessionId, source).then(...)`. `pollSession` at line 446 is typed
`source: 'timer' | 'event'`. If `source` is `'fs-event'`, that's a second
TypeScript error.

**Required:**
- `GitEditPoller` interface line 340: `source: 'event' | 'fs-event'`
- `pollSession` line 446: `source: 'timer' | 'event' | 'fs-event'`

---

## [BLOCKER] Fallback cadence is contradicted three ways within the spec

**File:** `docs/file-edits-v3.3.md` — Scope §, Wire into git-edit-poller §,
Acceptance tests 4 and 7

| Location | What it says |
|---|---|
| Scope | "Falls back to existing 1.5s/5s polling if chokidar fails" |
| scheduleTimer design | "drops the active cadence (1.5s) and always uses idle cadence (5s)" |
| Acceptance test 4 | "falls back to timer-only at 5s cadence" (no 1.5s) |
| Acceptance test 7 | "behavior is exactly V3.2 (5s idle, 1.5s active)" |

Tests 4 and 7 directly contradict each other. "Always uses idle cadence"
means the 1.5s active path is dropped in all cases, yet test 7 expects it
to survive.

**Resolution:** Specify whether the 1.5s active cadence is retained in the
non-watching fallback. If retained, scheduleTimer must say "drops active
cadence only when `isWatching` is true."

---

## [BLOCKER] Acceptance test 7 is untestable in V3.3's own scope

**File:** `docs/file-edits-v3.3.md:237`

> "Server starts with chokidar disabled → behavior is exactly V3.2 (5s idle,
> 1.5s active)."

V3.3's Config section defers `CACO_FILE_EDITS_WATCH=off` to V4. There is no
mechanism in V3.3 to disable chokidar without mocking. Either add a minimal
config toggle to V3.3 scope, or replace this AC with one testable in V3.3
(e.g., the mock-based test 4 already covers the fallback path).

---

## [IMPORTANT] `chokidar` is not in `package.json`; spec never says to add it

**Files:** `package.json` (verified: no `chokidar` entry), spec line 100

The spec says "Use `chokidar` (npm dep)" but gives no instruction to
`npm install chokidar`. Without adding it, the `import chokidar from 'chokidar'`
in `file-watcher.ts` fails at runtime.

Add to the implementation section: `npm install chokidar`. Also note the
correct version — see next finding.

---

## [IMPORTANT] Spec says "chokidar v3"; current release is v5 with breaking changes

**File:** `docs/file-edits-v3.3.md:246`

Per the chokidar README:
- **v4** (Sep 2024): drops `fsevents`, removes glob support from `ignored`,
  min Node v14.
- **v5** (Nov 2025): ESM-only, min Node v20.

Caco has `"type": "module"` and targets Node 20+, so v5 is compatible. The
footprint claim ("~250KB, optional fsevents") is stale. The spec says
`ignored: ignoreInstance` using the `ignore` package as a function — that's
fine for v4/v5. But an implementer reading "chokidar v3" gets the older API
and the stale fsevents optional dep.

Recommend: pin to `chokidar@^5` (or `^4` with note), update the footprint
estimate, drop the fsevents mention.

---

## [IMPORTANT] `atomic` option missing; `awaitWriteFinish` alone doesn't cover vim-style saves

**File:** `docs/file-edits-v3.3.md:104`, Open Questions item 1

Chokidar has a dedicated `atomic` option (verified in README): "emit proper
events when 'atomic writes' (mv _tmp file) are used."

`awaitWriteFinish` handles chunked/large writes by polling size stability.
`atomic` handles the rename-over pattern (vim `:w` with `backupcopy=auto`,
emacs, many CI tools) by detecting the temp-file-then-rename sequence and
emitting a single `change`.

Without `atomic: true`, vim saves emit an `unlink` + `add` pair that bypasses
`awaitWriteFinish` (which applies to `add`/`change`, not `unlink`), generating
two triggers.

**Resolution:** Use both. The options don't conflict.

---

## [IMPORTANT] Resource bound math is internally inconsistent; "well under 8192" is wrong

**File:** `docs/file-edits-v3.3.md:160–167`, Risks 242–245

Three different scenarios produce three contradictory impressions:

| Location | Numbers | Impression |
|---|---|---|
| Resource bounds | "~100–2000 directories; well under 8192 default" | Safe |
| Resource bounds | "51 sessions × ~500 dirs = ~25k watch slots" | 3× over default |
| Risks | "16 sessions × 2000 dirs = 32k watches; default 8192" | 4× over |

"Well under 8192" compares per-session dir count to process-wide budget —
wrong unit of comparison. Even 10 sessions × 300 dirs = 3,000 slots is fine,
but 20 sessions × 500 dirs = 10,000 exceeds default.

**Resolution:** Replace with: "Across all sessions, chokidar uses inotify
watches proportionally to total directories watched. With N active sessions
× D directories average: 10 × 300 = 3,000 (safe), 20 × 500 = 10,000
(exceeds default 8192). Operators on busy servers or large repos should raise
the limit."

---

## [IMPORTANT] NFS regression not flagged: 30s backstop silently degrades from V3.2's 5s

**File:** `docs/file-edits-v3.3.md:178–183`, scheduleTimer 132–137

Failure mode 3 notes that NFS/FUSE mounts don't fire inotify events. What
the spec doesn't say: on Linux, `fs.watch`/inotify *attaches* to NFS without
error — the watcher opens, chokidar's `error` event never fires,
`isWatching(sessionId)` returns true. The 30s backstop activates.

Result: NFS users get 30s latency instead of V3.2's 1.5–5s — a silent
regression. The user can't distinguish "chokidar attached and working" from
"chokidar attached and silent."

Suggested: add to Risks: "NFS users without explicit opt-out will silently
degrade from 5s polling to 30s."

---

## [IMPORTANT] Race: `fileWatcher.attach` fires before initial non-guarded poll; spurious broadcast on attach

**File:** `docs/file-edits-v3.3.md:119–123`, `src/git-edit-poller.ts:519–536`

Spec order:
1. `sessions.set(sessionId, state)` with `lastDirty: new Map()` (empty)
2. `fileWatcher.attach(...)` — NEW
3. Initial inline git-status poll (does NOT set `state.polling = true`)
4. `scheduleTimer`

If chokidar fires between 2 and 3 (window: async `runGit`), `triggerPoll`
debounces. `pollSession` sees `state.polling = false` and runs concurrently
with the inline poll. `lastDirty` is still empty, so every dirty file is
"new" and broadcasts on attach — before the applet has even opened.

**Fix:** Move `fileWatcher.attach` to after line 534 (after initial poll
completes), so `lastDirty` is populated before any chokidar event can
trigger a broadcast.

---

## [NICE] `followSymlinks: false` overrides chokidar's default; not stated

**File:** `docs/file-edits-v3.3.md:213–215`

Chokidar's default is `followSymlinks: true`. The spec says "V3.3 goes with
`false` for safety" but doesn't say it's overriding the default. An
implementer might assume the default is `false` and omit the option.

Add "(overrides chokidar default of `true`)".

---

## [NICE] Gitignore reload limitation should appear in Failure Modes table

**File:** `docs/file-edits-v3.3.md:210–212`

Currently in Edge Cases prose. For long-running servers, mid-run `.gitignore`
edits leave the watcher's ignore list stale. Polls fire harmlessly but
wastefully on newly-ignored paths.

Add a Failure Modes bullet: "`.gitignore` updated at runtime → watcher's
ignore list stale until server restart. Events may fire for newly-ignored
paths (harmless; polls are no-ops if git status doesn't change)."

---

## [NICE] Actual `max_user_watches` value on this system not verified

**File:** `docs/file-edits-v3.3.md:163`

The spec asserts "inotify default is 8192/user" as fact. Stock Arch is 8192,
but varies (Ubuntu 22.04: 8192, WSL2: 8192, cloud VMs: varies). The
troubleshooting section the spec promises should include
`cat /proc/sys/fs/inotify/max_user_watches`.

---

## [QUESTION] Should `atomic: true` combine with `awaitWriteFinish`?

See IMPORTANT above. Recommend yes; options handle different patterns and
don't conflict.

---

## [QUESTION] Should `fileWatcher.attach` be ordered after the initial poll?

See IMPORTANT above. Moving attach to after the initial poll completes
eliminates the spurious-broadcast race with no downside.

---

## [QUESTION] `FileWatcher` keyed on `sessionId` — V4 sharing path pre-considered?

V3.3 keys `FileWatcher` on `sessionId`. V4 plans to refcount by repoRoot.
The V3.3 interface would need significant changes for repoRoot-keyed sharing.
Consider whether the V3.3 interface should accept a `repoRoot` key internally
(still exposed by sessionId externally), or explicitly mark as
internal-to-poller (not exported) so it can change freely in V4.

---

## Summary assessment

The spec is well-structured, self-contained for a fresh agent, and correctly
identifies the watch-store vs chokidar trade-off (watch-store is
lease-based/user-visible/non-recursive; chokidar for internal recursive
polling trigger is a legitimately different use case). The decision not to
extend watch-store holds.

Three blockers must be resolved before implementation:
1. Both `triggerPoll` and `pollSession` type unions need `'fs-event'`.
2. Fallback cadence (1.5s vs 5s when chokidar is not watching) must be
   definitively specified.
3. Acceptance test 7 must be made testable in V3.3 or replaced.

Otherwise implementable as a single increment with no V3.2 conflicts.
