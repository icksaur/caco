# Git Status Applet - Research & Design

Research notes on implementing a git front-end applet in Caco.

## How Git Front-ends Work

### Core Git Operations

Git GUIs wrap the git CLI or use git libraries. Key operations:

| Operation | Git Command | Output |
|-----------|-------------|--------|
| Status | `git status --porcelain=v2` | Machine-parseable file states |
| Diff | `git diff [--cached] [file]` | Unified diff output |
| Stage | `git add <file>` | Adds to index |
| Unstage | `git restore --staged <file>` | Removes from index |
| Commit | `git commit -m "msg"` | Creates commit |
| Log | `git log --oneline -n 20` | Recent commits |
| Branch | `git branch -a` | List branches |

### Porcelain v2 Status Format

`git status --porcelain=v2` outputs machine-parseable status:

```
1 .M N... 100644 100644 100644 abc123 def456 src/file.ts
1 A. N... 000000 100644 100644 000000 abc123 newfile.ts
? untracked-file.txt
```

Fields:
- `1` = ordinary entry, `2` = rename/copy, `?` = untracked, `!` = ignored
- XY = index status + worktree status (M=modified, A=added, D=deleted, .=unchanged)
- File path at end

### How GitHub Desktop Works

- **Electron app** - Node.js backend + Chromium frontend
- **dugite** - Node.js git bindings (spawns git process)
- **React UI** - TypeScript, similar to our applet runtime
- **IPC** - Main process runs git, renderer displays results

Key insight: GitHub Desktop runs `git` CLI commands, not libgit2. Shell execution is the standard approach.

### isomorphic-git (Browser-based)

Pure JavaScript git implementation. Status values:
- `*modified` - Modified in working dir, not staged
- `modified` - Modified and staged
- `*added` - Untracked file
- `added` - New file staged
- `*deleted` - Deleted in working dir
- `deleted` - Deletion staged

We don't need isomorphic-git since we can shell out to git.

## Caco Implementation Approach

### Architecture Decision

**Implemented: Generic Shell Endpoint** (`/api/shell`)

The `/api/shell` endpoint is already implemented in `src/routes/shell.ts`. It executes any command without allowlist - this is local power-user software that can do anything anyway.

Features:
- Uses `execFile` with args array (no shell injection)
- Output sanitization (ANSI stripped, CRLF normalized)
- CWD validation (must be absolute, must exist)
- Timeout handling
- Returns `{ stdout, stderr, code }`

See [shell-api.md](shell-api.md) for full specification.

### Git Commands via Shell API

```javascript
// Example: get git status
const response = await fetch('/api/shell', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    command: 'git',
    args: ['status', '--porcelain=v2']
  })
});
const { stdout, stderr, code } = await response.json();
```

All git operations work through this single endpoint:
- `git status --porcelain=v2` - Machine-parseable status
- `git diff [--cached] [file]` - Unified diff
- `git add <file>` - Stage file
- `git restore --staged <file>` - Unstage file
- `git commit -m "msg"` - Commit
- `git log --oneline -n 20` - Recent commits
- `git branch -a` - List branches

### Current Applet Capabilities

From applet.md and applet-runtime.ts, applets have:

| Capability | API | Notes |
|------------|-----|-------|
| Shell commands | `fetch('/api/shell', ...)` | ✅ For git commands |
| Read files | `callMCPTool('read_file', {path})` | For viewing file content |
| Write files | `callMCPTool('write_file', {path, content})` | Not needed for git |
| List dirs | `callMCPTool('list_directory', {path})` | Not git-aware |
| Agent request | `sendAgentMessage(prompt)` | For complex operations |
| State sync | `setAppletState({...})` | For selected file, etc |
| Agent push | `onStateUpdate(callback)` | Agent can push to applet |

### What's Needed for Git Applet

1. ~~Shell execution API~~ ✅ Implemented
2. **Streaming/refresh** - Manual refresh for now, optional polling later
3. **Diff display** - Raw diff in `<pre>` initially

### Implementation Options

~~Option A, B, C - Superseded by implemented `/api/shell` endpoint.~~

See "Architecture Decision" above.

### Streaming / Live Refresh

Git status can change when:
- User edits files (external editor)
- User runs git commands in terminal
- Files are created/deleted

Options for live updates:

| Approach | Implementation | Latency |
|----------|---------------|---------|
| **Polling** | Applet polls `/api/git/status` every N seconds | N seconds |
| **File watcher** | Server watches `.git/index` changes, pushes via WS | ~instant |
| **Manual refresh** | User clicks refresh button | Manual |

**Recommendation**: Start with manual refresh + optional polling (e.g., 5s interval).

### Diff Display

For showing file diffs, options:

1. **Raw diff** - Just show `git diff` output in `<pre>`
2. **Split view** - Parse diff, show old/new side by side
3. **Inline view** - Syntax highlighted with +/- lines

Libraries:
- **diff2html** - Renders git diff to HTML
- **Prism.js** - Syntax highlighting (already considering for chat)

### Applet UI Components

Minimal git status applet:

```
┌─────────────────────────────────────┐
│ Branch: main ↑2 ↓1        [Refresh] │
├─────────────────────────────────────┤
│ Staged Changes (2)           [−all] │
│   ☑ M src/file.ts                   │
│   ☑ A newfile.ts                    │
├─────────────────────────────────────┤
│ Changes (3)                  [+all] │
│   ☐ M src/other.ts                  │
│   ☐ D deleted.ts                    │
│   ☐ ? untracked.txt                 │
├─────────────────────────────────────┤
│ [Commit message...]        [Commit] │
└─────────────────────────────────────┘
```

Click file → shows diff in expanded section or side panel.

## Implementation Phases

### Phase 1: Read-only Status ✅

- [x] `/api/shell` endpoint (already implemented)
- [x] Create basic git-status applet (HTML/JS/CSS)
- [x] Display file list with status icons
- [x] Manual refresh button
- [x] Parse `git status --porcelain=v2` output
- [x] Accept `?path=/path/to/repo` URL param for repository path

**Usage:** `/?applet=git-status&path=/home/carl/copilot-web`

### Phase 2: Staging ✅

- [x] Checkbox UI for staging individual files
- [x] Stage all / Unstage all buttons
- [x] Call `git add` / `git restore --staged` via shell

### Phase 3: Diff View → Separate applet: `git-diff`

Moved to separate applet for simplicity. Click file in git-status → opens git-diff.

- [ ] Create git-diff applet
- [ ] Accept file path via URL param
- [ ] Call `git diff [--cached] <file>` via shell
- [ ] Basic syntax highlighting (diff2html or raw)

### Phase 4: Commit ✅

- [x] Commit message input
- [x] Commit button (only enabled when staged files exist)
- [x] Call `git commit -m "msg"` via shell

### Phase 5: Push/Pull ✅

- [x] Add push button to header
- [x] Add pull button to header  
- [x] Show ahead/behind count next to branch name
- [x] Call `git push` / `git pull` via shell
- [x] Handle push/pull errors (no remote, conflicts, etc.)

### Phase 6: Auto-Refresh (Analysis: NOT RECOMMENDED)

#### The Request

Add optional polling to auto-refresh git status every N seconds.

#### The Problem

If we add `setInterval(refresh, 5000)` in git-status, the interval leaks:
- When applet is replaced by another applet
- When applet panel is hidden
- When browser tab is backgrounded
- When browser/OS goes to sleep
- When network disconnects (SSH tunnel dropped)

This wastes network over tunnels and could cause errors.

#### Proposed Solution: Applet Lifecycle API

| API | Purpose |
|-----|---------|
| `appletAPI.onCleanup(callback)` | Called when applet is destroyed/replaced |
| `appletAPI.onVisibilityChange(callback)` | Called when applet panel shown/hidden |
| `appletAPI.isVisible()` | Check if applet panel currently visible |

#### Detailed Implementation Requirements

**Files to modify:**

1. `public/ts/applet-runtime.ts`
   - Add `cleanupCallbacks: (() => void)[]` to `AppletInstance` interface
   - Add global `visibilityCallbacks: ((visible: boolean) => void)[]`
   - Implement `onCleanup()` - push to instance's callback array
   - Implement `onVisibilityChange()` - push to global callback array
   - Implement `isVisible()` - combine panel + document visibility
   - Wire `document.visibilitychange` event listener
   - Call all callbacks in `destroyInstance()` with try/catch per callback

2. `public/ts/view-controller.ts`
   - Export visibility change event (new function or callback pattern)
   - `showAppletPanel()` and `hideAppletPanel()` need to notify runtime

3. `doc/API.md`
   - Document new appletAPI methods

4. `doc/applet.md` (applet howto equivalent)
   - Add lifecycle section with usage examples

**Edge cases to handle:**

| Edge Case | Required Behavior |
|-----------|-------------------|
| Callback throws | Must not break other callbacks or cleanup |
| Browser sleep/wake | `visibilitychange` fires, but network may be dead |
| Tab backgrounded | `document.hidden` becomes true |
| Panel hidden (user clicks chat) | `isAppletPanelVisible()` becomes false |
| Rapid show/hide | Debounce? Or trust applet to handle? |
| Cleanup during callback execution | Prevent re-entrancy |
| Memory leaks | Callbacks must be cleared on destroy |

**Coupling introduced:**

```
applet-runtime.ts ←→ view-controller.ts (NEW coupling)
                  ←→ document.visibilitychange
                  ←→ applet JS callbacks
                  ←→ network state (indirectly)
```

#### Code Quality Analysis

Reviewing against [code-quality.md](../code-quality.md):

| Principle | Assessment |
|-----------|------------|
| **Complexity** | ⚠️ MODERATE - Multiple visibility signals to combine |
| **Coupling** | ⚠️ NEW - Runtime now couples to view-controller |
| **Side effects** | ⚠️ Callbacks are side effects by nature |
| **Code must be kept in sync** | ⚠️ Visibility sources must agree |
| **Relying on side effects** | ⚠️ Entire feature is callback-based |

**Failure modes:**

1. **Callback throws during cleanup** → Other callbacks don't run → Leaked resources
   - Mitigation: try/catch each callback individually
   - Cost: Extra code, silent failures

2. **View-controller changes without notifying runtime** → Stale visibility state
   - Mitigation: Runtime subscribes to view-controller
   - Cost: New coupling

3. **Browser goes to sleep** → `visibilitychange` fires but network dead
   - Mitigation: Applet must handle fetch errors anyway
   - Cost: More error handling in applets

4. **Race: cleanup called while visibility callback running** → Undefined behavior
   - Mitigation: Guard flags, careful ordering
   - Cost: Defensive code

5. **Memory leak: callbacks registered but applet not cleaned up** → Callbacks accumulate
   - Mitigation: Callbacks stored per-instance, cleared on destroy
   - Cost: Careful bookkeeping

#### Cost/Benefit Analysis

**Costs:**
- ~100-150 lines of new runtime code
- New coupling between modules
- 5+ edge cases to handle correctly
- Testing complexity (visibility states hard to test)
- Documentation overhead
- Every future applet author must understand lifecycle

**Benefits:**
- Applets can poll safely
- Applets can do cleanup (WebSocket close, etc.)

**But consider the actual use case:**

For git-status polling:
- User actively working → clicks refresh when needed (current behavior)
- User away → doesn't need updates
- Polling every 5s = 12 requests/minute = mostly wasted

**Manual refresh already works perfectly.** The refresh button is already implemented.

#### Recommendation: DO NOT IMPLEMENT

The lifecycle API is:
- Moderate complexity with multiple failure modes
- Introduces coupling that doesn't exist today
- Solves a problem (polling) that has a simpler solution (manual refresh)
- Benefits don't justify the maintenance burden

**Alternative: Keep manual refresh.** It's:
- Zero complexity
- Zero coupling
- Zero failure modes
- Already implemented
- User clicks when they want updates

If we later find a strong use case for lifecycle hooks (e.g., WebSocket cleanup, expensive resource teardown), we can revisit. But polling git status is not that use case.

---

### Alternative B: Server-Side File Watching via WebSocket

Instead of client-side polling, the server watches for changes and pushes events.

#### Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  git-status     │◄───────────────────│  Caco Server    │
│  applet (JS)    │   "git:changed"    │                 │
└─────────────────┘                    └────────┬────────┘
                                                │
                                       ┌────────▼────────┐
                                       │  File Watcher   │
                                       │  (inotify/poll) │
                                       └────────┬────────┘
                                                │
                                       ┌────────▼────────┐
                                       │  .git/index     │
                                       │  working tree   │
                                       └─────────────────┘
```

#### Concrete Implementation Options

**1. Node.js `fs.watch()` / `fs.watchFile()`**

| API | Mechanism | Reliability |
|-----|-----------|-------------|
| `fs.watch()` | inotify (Linux), FSEvents (macOS), ReadDirectoryChangesW (Windows) | Platform-dependent, may miss events |
| `fs.watchFile()` | Polling (stat every N ms) | Reliable but CPU-intensive |

```javascript
// Server-side
fs.watch(path.join(repoPath, '.git/index'), (event) => {
  ws.send({ type: 'git:changed', repo: repoPath });
});
```

**Problems with `fs.watch()`:**
- Recursive watching is not supported on all platforms
- May not fire for all changes (race conditions)
- File renames fire as delete + create
- `.git/index` changes don't capture all states (untracked files don't touch index)

**2. Chokidar (npm package)**

Popular wrapper that handles cross-platform issues:

```javascript
const chokidar = require('chokidar');
chokidar.watch(repoPath, { ignoreInitial: true })
  .on('all', (event, path) => {
    ws.send({ type: 'git:changed', repo: repoPath });
  });
```

**Problems with Chokidar:**
- Uses polling on network filesystems (NFS, SSHFS)
- Memory usage grows with watched file count
- Still platform-dependent behavior
- 500KB+ dependency

**3. Server-side polling (hidden from client)**

```javascript
// Server polls git status every N seconds
setInterval(async () => {
  const status = await execGitStatus(repoPath);
  if (status !== lastStatus) {
    ws.send({ type: 'git:changed', repo: repoPath });
    lastStatus = status;
  }
}, 5000);
```

**This is just client polling moved server-side.** Same waste, different location.

#### The Subscription Lifecycle Problem

**This is identical to the client polling problem:**

| Problem | Client Polling | Server Watching |
|---------|----------------|-----------------|
| What starts it? | Applet loads | Applet sends "subscribe" message |
| What stops it? | Applet destroyed | Applet sends "unsubscribe" message |
| What if stop fails? | Interval leaks | Watcher leaks |
| Browser goes to sleep? | Interval runs but can't fetch | Watcher runs, events queue up |
| Tab backgrounded? | Same | Same |
| Network dies? | Fetch fails | Events lost, client stale |

**The cleanup problem is identical:**

```javascript
// Client-side (git-status applet)
const subId = await appletAPI.subscribe('git:watch', { repo: repoPath });

// On cleanup... but what if this never runs?
appletAPI.unsubscribe(subId);
```

If the applet is destroyed without cleanup:
- Watcher keeps running on server
- Server keeps sending events to dead WebSocket
- Memory leak on server
- CPU waste watching unwanted paths

**Lease-based approach:**

```javascript
// Client must renew lease every 30s
const leaseId = await appletAPI.subscribe('git:watch', { 
  repo: repoPath, 
  leaseDuration: 30000 
});

// Renewal loop
setInterval(() => {
  appletAPI.renewLease(leaseId);
}, 25000);
```

**But this introduces the SAME problem:** What if the renewal loop doesn't stop?

| Scenario | Result |
|----------|--------|
| Applet destroyed normally | Loop keeps running, renewing dead subscription |
| Browser tab closed | Lease expires (good), but only after 30s lag |
| Browser goes to sleep | Lease may or may not expire depending on timers |
| Network dies | Renewal fails, lease expires, but client doesn't know |

**We've moved the problem, not solved it.**

#### Complexity Comparison

| Approach | Client Code | Server Code | New Dependencies | Failure Modes |
|----------|-------------|-------------|------------------|---------------|
| Client polling | ~20 lines | 0 | 0 | 3-4 |
| Server file watching | ~30 lines | ~100 lines | chokidar or custom | 6-8 |
| Lease-based watching | ~50 lines | ~150 lines | chokidar + lease manager | 10+ |
| **Manual refresh** | **0 lines** | **0** | **0** | **0** |

#### Server Resource Concerns

File watchers consume server resources:

| Resource | Impact |
|----------|--------|
| File descriptors | Each watched path = 1+ FD (inotify has limits) |
| Memory | Chokidar stores file metadata |
| CPU | Polling fallback on network FS |
| Complexity | Watch lifecycle tied to connection lifecycle |

**What happens when:**
- 10 browser tabs open the same repo? 10 watchers? Or shared?
- User opens repo, closes tab, opens again? Cleanup race?
- Server restarts? All subscriptions lost, clients don't know

#### Conclusion: Server Watching is WORSE

Server-side file watching:
- Same lifecycle/cleanup problems as client polling
- Additional server-side complexity
- Additional dependencies
- Additional failure modes (watcher leaks, FD exhaustion)
- Cross-platform filesystem watching is notoriously unreliable

**The fundamental problem remains:** We need lifecycle hooks to know when to stop, regardless of whether polling/watching happens client-side or server-side.

**Manual refresh avoids all of this.**

---

#### If We DO Implement Later

Design principles to follow:

1. **onCleanup can NEVER fail** - wrap each callback in try/catch, log errors, continue
2. **Visibility is derived, not stored** - always compute from sources, don't cache
3. **Cleanup is idempotent** - calling twice is safe, no double-free
4. **Callbacks are synchronous** - no async cleanup (can't await in destroy)
5. **Test the edge cases** - unit tests for each failure mode above

```javascript
// Safe cleanup pattern
function destroyInstance(instance) {
  for (const cb of instance.cleanupCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('[APPLET] Cleanup callback error (ignored):', err);
    }
  }
  instance.cleanupCallbacks = []; // Prevent double-call
  // ... rest of destroy
}
```

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Command injection | ✅ Uses `execFile` not `exec`, args as array |
| Path traversal | CWD validated (absolute, exists) |
| Arbitrary commands | Accepted - local power-user software |

## Decision

**Implemented: Generic Shell Endpoint** without allowlist.

Reasons:
- Local power-user software - can do anything anyway
- Reusable for any developer tool applet (git, docker, npm, make)
- Agent can create applets that use shell commands
- One-time implementation, infinite applet possibilities

## References

- [GitHub Desktop](https://github.com/desktop/desktop) - Electron git GUI
- [isomorphic-git status](https://isomorphic-git.org/docs/en/status) - Browser git status
- [git status --porcelain=v2](https://git-scm.com/docs/git-status) - Machine output format
- [applet.md](applet.md) - Caco applet system design
