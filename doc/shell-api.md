# Shell API Specification

Shell execution endpoint for applets and developer tools.

## Overview

The `/api/shell` endpoint provides shell command execution from applets. This enables developer tool applets (git, docker, npm, make) without requiring LLM round-trips for each command.

## Endpoint

### `POST /api/shell`

Execute a command.

**Request:**
```json
{
  "command": "git",
  "args": ["status", "--porcelain=v2"],
  "cwd": "/optional/working/directory"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Command name |
| `args` | string[] | No | Command arguments (default: `[]`) |
| `cwd` | string | No | Working directory (default: server cwd) |

**Response (success):**
```json
{
  "stdout": "1 M. N... 100644 100644 100644 abc123 src/file.ts\n",
  "stderr": "",
  "code": 0
}
```

**Response (command error):**
```json
{
  "stdout": "",
  "stderr": "fatal: not a git repository\n",
  "code": 128
}
```

**Response (API error):**
```json
{
  "error": "Working directory does not exist"
}
```

| Status | Condition |
|--------|-----------|
| 200 | Command executed (even if exit code non-zero) |
| 400 | Missing command field or invalid cwd |
| 408 | Command timed out |
| 500 | Execution error (command not found) |

## Output Sanitization

All output is sanitized before return:

### 1. ANSI/VT Escape Code Stripping

Terminal escape codes (colors, cursor movement) are stripped:

```javascript
import { stripVTControlCharacters } from 'node:util';

stdout = stripVTControlCharacters(stdout);
stderr = stripVTControlCharacters(stderr);
```

This uses Node.js built-in (v16.11+), equivalent to npm `strip-ansi`.

### 2. Line Ending Normalization

CRLF (`\r\n`) is normalized to LF (`\n`):

```javascript
stdout = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '');
```

### 3. Carriage Return Handling

Bare `\r` (used for progress bars, spinners) is handled:
- Strip CR that would overwrite content
- Result is final visible text only

### 4. Encoding

- Output is decoded as UTF-8
- Invalid byte sequences are replaced with U+FFFD

## Security Notes

This is desktop software for personal use. Security is minimal by design.

### execFile (not exec)

Using `child_process.execFile()` with separate args array:

```javascript
import { execFile } from 'node:child_process';

// Args passed as array, not concatenated string
execFile(command, args, { cwd }, callback);
```

Arguments are passed directly to the executable, not through a shell. This means no shell metacharacter interpretation - commands like `git status ; rm -rf /` would pass `; rm -rf /` as a literal argument to git (which would fail harmlessly).

### Path Validation

The `cwd` parameter is validated:
- Must be absolute path
- Must exist and be a directory

### Resource Limits

| Limit | Value | Config Key |
|-------|-------|------------|
| Timeout | 60 seconds | `EXEC_TIMEOUT_MS` |
| Max output | 10 MB | `EXEC_MAX_BUFFER_BYTES` |

Commands exceeding limits are killed with SIGTERM.

### No Shell Expansion

Since we use `execFile` (not `exec`):
- No glob expansion (`*`, `?`)
- No environment variable substitution (`$HOME`)
- No command chaining (`;`, `&&`, `|`)
- No redirects (`>`, `<`)

Commands handle their own patterns (e.g., `git add .`).

## Implementation Notes

### Using `child_process.execFile`

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripVTControlCharacters } from 'node:util';

const execFileAsync = promisify(execFile);

async function executeCommand(command, args, cwd, options) {
  const { timeout, maxBuffer } = options;
  
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer,
      encoding: 'utf8',
      windowsHide: true,  // No console window on Windows
    });
    
    return {
      stdout: sanitizeOutput(stdout),
      stderr: sanitizeOutput(stderr),
      code: 0,
    };
  } catch (error) {
    // execFile throws on non-zero exit code
    return {
      stdout: sanitizeOutput(error.stdout || ''),
      stderr: sanitizeOutput(error.stderr || ''),
      code: error.code ?? 1,
    };
  }
}

function sanitizeOutput(text) {
  // Strip ANSI escape codes
  text = stripVTControlCharacters(text);
  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  return text;
}
```

### Error Handling

| Error Type | Handling |
|------------|----------|
| Command not found | Return 500 with spawn error |
| Permission denied | Return in stderr, code != 0 |
| Timeout (SIGTERM) | Return 408, partial output |
| Buffer exceeded | Return 500, output truncated |
| Invalid cwd | Return 400 with path error |

### TypeScript Interface

```typescript
interface ShellRequest {
  command: string;
  args?: string[];
  cwd?: string;
}

interface ShellResponse {
  stdout: string;
  stderr: string;
  code: number;
}

interface ShellError {
  error: string;
}
```

## Applet Usage Examples

### Git Status

```javascript
async function getGitStatus() {
  const response = await fetch('/api/shell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'git',
      args: ['status', '--porcelain=v2']
    })
  });
  const { stdout, stderr, code } = await response.json();
  
  if (code !== 0) {
    throw new Error(stderr || 'git status failed');
  }
  
  return parseGitStatus(stdout);
}
```

### Directory Listing

```javascript
async function listFiles(dir) {
  const response = await fetch('/api/shell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'ls',
      args: ['-la', dir]
    })
  });
  return response.json();
}
```

### Docker Container List

```javascript
async function getContainers() {
  const response = await fetch('/api/shell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'docker',
      args: ['ps', '--format', '{{json .}}']
    })
  });
  const { stdout } = await response.json();
  
  return stdout.trim().split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}
```

## Testing Strategy

### Unit Tests

1. **Allowlist enforcement** - Blocked commands return 403
2. **Output sanitization** - ANSI stripped, CRLF normalized
3. **Timeout handling** - Long commands are killed
4. **Error cases** - Command not found, permission denied

### Integration Tests

1. **Git operations** - status, diff, log
2. **File operations** - ls, cat, grep
3. **Working directory** - cwd parameter works
4. **Large output** - Buffer limit handling

### Security Tests

1. **Command injection** - Args with metacharacters don't execute
2. **Path traversal** - Cannot cwd to sensitive directories
3. **Blocked commands** - rm, chmod, etc. are rejected

## Configuration

Add to `config.ts`:

```typescript
// Shell API
export const SHELL_ALLOWLIST = [
  'git', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'diff',
  'docker', 'npm', 'npx', 'make', 'cargo', 'go', 'python', 'pip'
];
```

## Future Enhancements

### Streaming Output

For long-running commands, could stream output via WebSocket:

```javascript
// Future: WebSocket streaming
ws.send({ type: 'shell.start', id: 'abc123' });
ws.send({ type: 'shell.stdout', id: 'abc123', data: 'line 1\n' });
ws.send({ type: 'shell.exit', id: 'abc123', code: 0 });
```

### Applet-Scoped Allowlist

Applets could declare their command needs:

```javascript
{
  "slug": "git-status",
  "permissions": ["shell:git"]
}
```

### Interactive Commands

For commands that need stdin (e.g., `npm init`), could add PTY support.

## References

- [Node.js child_process.execFile](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
- [Node.js util.stripVTControlCharacters](https://nodejs.org/api/util.html#utilstripvtcontrolcharactersstr)
- [git-applet.md](git-applet.md) - Git applet design (uses this API)
- [ANSI escape codes](https://en.wikipedia.org/wiki/ANSI_escape_code)
