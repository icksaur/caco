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

### Architecture Options

| Approach | Pros | Cons |
|----------|------|------|
| **Shell out via agent** | Agent runs `git status`, parses output | Every refresh = LLM call, slow |
| **HTTP endpoint** | New `/api/git/status` endpoint | Fast, no LLM, but new code |
| **MCP tool from applet** | Applet calls `callMCPTool('run_shell', ...)` | Uses existing tool, no new endpoints |

**Recommended**: New HTTP endpoints for git operations. Fast, no agent round-trip.

### Proposed HTTP Endpoints

```
GET  /api/git/status              → { files: [...], branch, ahead, behind }
GET  /api/git/diff?path=file.ts   → { diff: string }
POST /api/git/stage               ← { paths: [...] }
POST /api/git/unstage             ← { paths: [...] }
POST /api/git/commit              ← { message: string }
GET  /api/git/log?n=20            → { commits: [...] }
```

### Current Applet Capabilities

From applet.md and applet-runtime.ts, applets already have:

| Capability | API | Notes |
|------------|-----|-------|
| Read files | `callMCPTool('read_file', {path})` | For viewing diffs? |
| Write files | `callMCPTool('write_file', {path, content})` | Not needed for git |
| List dirs | `callMCPTool('list_directory', {path})` | Not git-aware |
| Agent request | `sendAgentMessage(prompt)` | Too slow for UI refresh |
| State sync | `setAppletState({...})` | For selected file, etc |
| Agent push | `onStateUpdate(callback)` | Agent can push to applet |

**Gap**: No shell execution from applet JS. The MCP tools only do file I/O.

### What's Missing for Git Applet

1. **Shell execution API** - Applet needs to run git commands
2. **Streaming/refresh** - File system changes trigger UI update
3. **Syntax highlighting** - For diff display

### Implementation Options

#### Option A: New `/api/git/*` Endpoints

Add git-specific routes in `src/routes/git.ts`:

```typescript
router.get('/status', async (req, res) => {
  const result = await exec('git status --porcelain=v2');
  const files = parseGitStatus(result.stdout);
  res.json({ files });
});
```

**Pros**: Fast, clean API, purpose-built
**Cons**: Git-specific code, may want shell access for other use cases

#### Option B: Generic Shell Endpoint

Add `/api/shell` endpoint (limited commands):

```typescript
router.post('/shell', async (req, res) => {
  const { command, args, cwd } = req.body;
  // Allowlist: git, ls, cat, grep, etc.
  if (!ALLOWED_COMMANDS.includes(command)) {
    return res.status(403).json({ error: 'Command not allowed' });
  }
  const result = await exec(`${command} ${args.join(' ')}`, { cwd });
  res.json({ stdout: result.stdout, stderr: result.stderr, code: result.code });
});
```

**Pros**: Reusable for other applets (docker, make, etc.)
**Cons**: Security surface, need careful allowlisting

#### Option C: Agent-Mediated (Current Capability)

Use `sendAgentMessage('run git status and set_applet_state with the result')`.

**Pros**: No new code
**Cons**: Slow (LLM round-trip), expensive (tokens), poor UX

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

### Phase 1: Read-only Status

- [ ] Add `/api/git/status` endpoint
- [ ] Create basic git-status applet (HTML/JS/CSS)
- [ ] Display file list with status icons
- [ ] Manual refresh button

### Phase 2: Staging

- [ ] Add `/api/git/stage` and `/api/git/unstage`
- [ ] Checkbox UI for staging individual files
- [ ] Stage all / Unstage all buttons

### Phase 3: Diff View

- [ ] Add `/api/git/diff` endpoint
- [ ] Click file to view diff
- [ ] Basic syntax highlighting

### Phase 4: Commit

- [ ] Add `/api/git/commit` endpoint
- [ ] Commit message input
- [ ] Commit button (only enabled when staged files exist)

### Phase 5: Polish

- [ ] Branch display with ahead/behind count
- [ ] Auto-refresh option
- [ ] Keyboard shortcuts
- [ ] Error handling (not a git repo, etc.)

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Command injection | Use `execFile` not `exec`, pass args as array |
| Path traversal | Lock to workspace CWD |
| Arbitrary commands | If generic shell, strict allowlist |

## Alternative: Let Agent Create It

Instead of building git endpoints, we could:
1. Add generic `/api/shell` endpoint (allowlisted commands)
2. Ask agent to create the git applet
3. Agent writes HTML/JS/CSS to disk
4. User loads applet

This leverages agent's code generation capability. The applet would call `/api/shell` with git commands.

## Decision

**Recommended approach**: Option B (Generic Shell Endpoint) with strict allowlist.

Reasons:
- Reusable for other developer tool applets (docker, npm, make)
- Agent can create applets that use shell commands
- One-time implementation, infinite applet possibilities
- Security via allowlist is manageable for localhost dev context

## References

- [GitHub Desktop](https://github.com/desktop/desktop) - Electron git GUI
- [isomorphic-git status](https://isomorphic-git.org/docs/en/status) - Browser git status
- [git status --porcelain=v2](https://git-scm.com/docs/git-status) - Machine output format
- [applet.md](applet.md) - Caco applet system design
