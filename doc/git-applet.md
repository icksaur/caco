# Git Applet

Two applets for git workflows: `git-status` (browse, stage, commit, push/pull) and `git-diff` (view file diffs).

## Architecture

**Implemented: Generic Shell Endpoint** (`/api/shell`)

The `/api/shell` endpoint is already implemented in `src/routes/shell.ts`. It executes any command without allowlist - this is local power-user software that can do anything anyway.

Features:
- Uses `execFile` with args array (no shell injection)
- Output sanitization (ANSI stripped, CRLF normalized)
- CWD validation (must be absolute, must exist)
- Timeout handling
- Returns `{ stdout, stderr, code }`

See [shell-api.md](shell-api.md) for full specification.

## Applet Capabilities

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

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Command injection | ✅ Uses `execFile` not `exec`, args as array |
| Path traversal | CWD validated (absolute, exists) |
| Arbitrary commands | Accepted - local power-user software |

## Decision

**Implemented: Generic Shell Endpoint** without allowlist. Local power-user software — reusable for any developer tool applet (git, docker, npm, make).
