# Research & Background

*Everything below is research that led to the above solution.*

## Architecture Clarification

### Caco = Daemon Server

```
┌─────────────────────────────────────────────────────────────┐
│  Caco Server (Node.js daemon)                               │
│  - Long-running process                                     │
│  - Caco's own env is stable, irrelevant to sessions         │
│  - Manages multiple concurrent CopilotClient instances      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Session A    │  │ Session B    │  │ Session C    │      │
│  │ cwd: /proj-a │  │ cwd: /proj-b │  │ cwd: /proj-c │      │
│  │ env: {...}   │  │ env: {...}   │  │ env: {...}   │      │
│  │ (gcc 7.5)    │  │ (node 18)    │  │ (python 3.9) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│        │                 │                 │                │
│        ▼                 ▼                 ▼                │
│  CopilotClient A   CopilotClient B   CopilotClient C       │
│  (own subprocess)  (own subprocess)  (own subprocess)      │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Each `CopilotClient` spawns its own subprocess. The `env` parameter controls that subprocess's environment, completely independent of:
- Caco server's process.env
- Other sessions' environments

### This is Different from copilot-cli

| Aspect | copilot-cli | Caco + SDK |
|--------|-------------|------------|
| Invocation | User runs from terminal | Daemon spawns on demand |
| Environment | Inherits user's shell | Passed explicitly per session |
| Concurrency | Single session | Multiple isolated sessions |
| Lifetime | Terminal session | Persistent daemon |

---

## Current State

### SDK Capabilities

```typescript
// Each CopilotClient can have its own env
const clientA = new CopilotClient({ 
  cwd: '/proj-a', 
  env: { PATH: '/gcc-7/bin:...', CC: 'gcc-7' }
});

const clientB = new CopilotClient({ 
  cwd: '/proj-b', 
  env: { PATH: '/node-18/bin:...', NODE_ENV: 'development' }
});

// These run in separate subprocesses with isolated environments
```

### Session & Client Lifetimes

#### Two Types of Persistence

| Storage | Lifetime | Contains |
|---------|----------|----------|
| **SDK on disk** | Permanent (until deleted) | Conversation history, cwd, summary |
| **Active in memory** | Until `stop()` called | CopilotClient subprocess, tools |

#### Lifecycle States

```
┌──────────────────────────────────────────────────────────────────┐
│                        SESSION LIFECYCLE                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SDK on disk              Memory (activeSessions)                │
│  ──────────────           ──────────────────────                 │
│                                                                  │
│  [Persisted]  ─────create()────▶  [Active]                      │
│       │                              │                           │
│       │       ◀────stop()──────     │                           │
│       │                              │                           │
│       │       ─────resume()────▶     │                           │
│       │                              │                           │
│       ▼                              ▼                           │
│  delete()                     Caco restart                       │
│  (removed)                    (subprocess dies)                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### When is a Session "Active"?

A session is **active** when:
- `CopilotClient` subprocess is running
- Entry exists in `activeSessions` Map
- Can receive messages immediately

A session is **persisted but inactive** when:
- History saved to `~/.copilot/session-state/<id>/`
- No subprocess running
- Must call `resume()` before sending messages

#### What Triggers `stop()`?

| Trigger | Code Location |
|---------|---------------|
| Explicit user action | Delete button in UI |
| Session expired (SDK-side) | `session-messages.ts`, `websocket.ts` |
| Caco server restart | All active sessions lost (not explicitly stopped) |
| Session delete | `session-manager.ts delete()` |

#### No Automatic Timeouts

Caco does **not** automatically stop idle sessions. An active session stays active until:
1. Explicitly stopped
2. SDK reports session expired
3. Server restarts

**Implication for environment:** Once a CopilotClient is created with an `env`, that subprocess keeps that environment until stopped. No need to "refresh" env for an already-active session.

### Current Caco Implementation

```typescript
const client = new CopilotClient({ cwd });  // env not passed!
```

**Problem:** We pass `cwd` but not `env`. All sessions inherit Caco daemon's process.env.

---

## What the SDK Provides (and Doesn't)

### SDK DOES Store

| Data | Location | Auto-restored on resume? |
|------|----------|--------------------------|
| `cwd` | `workspace.yaml` | **No** - must pass to `CopilotClient({ cwd })` |
| `gitRoot` | `session.start` event | No |
| `branch` | `session.start` event | No |
| Conversation history | `events.jsonl` | **Yes** - via `resumeSession()` |

### SDK Does NOT Store

| Data | Implication |
|------|-------------|
| `env` (environment variables) | **Must be managed by Caco** |
| Shell state | N/A |
| Virtual environments | Only if in PATH |

### How Resume Currently Works

```typescript
// Our current code in session-manager.ts resume()
const cwd = cached.cwd;  // We get cwd from our cache (which reads workspace.yaml)
const client = new CopilotClient({ cwd });  // Pass cwd, but NOT env
await client.resumeSession(sessionId, { tools, streaming: true });
```

The SDK's `resumeSession()` restores **conversation history only**. The execution environment (`cwd`, `env`) comes from the `CopilotClient` constructor, which we control.

### Conclusion

**Environment management is Caco's responsibility, not the SDK's.**

The SDK provides:
- ✓ Session history persistence
- ✓ cwd storage (but we must read and pass it ourselves)
- ✗ Environment variable storage/restoration

---

## Proposed Solution

### Phase 1: Capture Environment at Session Creation

Store the environment snapshot when creating a session:

```typescript
// In session-manager.ts create()
const envSnapshot = captureEnvironment();
storeSessionEnv(sessionId, envSnapshot);

const client = new CopilotClient({ cwd, env: envSnapshot });
```

**What to capture:**
- All of `process.env` (full snapshot)
- OR whitelist of relevant vars (PATH, VIRTUAL_ENV, NODE_ENV, API keys pattern)

**Storage location:**
- `~/.caco/sessions/<id>/env.json`

### Phase 2: Restore Environment on Resume

```typescript
// In session-manager.ts resume()
const savedEnv = loadSessionEnv(sessionId);
const client = new CopilotClient({ cwd, env: savedEnv ?? process.env });
```

### Phase 3: Staleness Detection (Optional)

Before restoring, validate key paths:

```typescript
function validateEnv(env: Record<string, string>): ValidationResult {
  const warnings: string[] = [];
  
  if (env.VIRTUAL_ENV && !existsSync(env.VIRTUAL_ENV)) {
    warnings.push(`Virtual environment no longer exists: ${env.VIRTUAL_ENV}`);
  }
  
  // Check PATH entries
  const pathDirs = (env.PATH || '').split(':');
  for (const dir of pathDirs) {
    if (!existsSync(dir)) {
      warnings.push(`PATH directory missing: ${dir}`);
    }
  }
  
  return { valid: warnings.length === 0, warnings };
}
```

---

## Security Considerations

### Secrets in Environment

Environment variables often contain secrets (API_KEY, DATABASE_URL, etc.). Storing them:
- **Risk**: Persisted to disk in plaintext
- **Mitigation options:**
  1. Encrypt env.json at rest
  2. Exclude vars matching secret patterns (API_KEY, SECRET, TOKEN, PASSWORD)
  3. Store only "safe" vars (PATH, VIRTUAL_ENV, NODE_ENV, SHELL, HOME)
  4. Prompt user before storing sensitive vars

### Recommended Approach

Default to a **safe whitelist**:

```typescript
const SAFE_ENV_VARS = [
  'PATH',
  'VIRTUAL_ENV',
  'NODE_ENV',
  'SHELL',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'EDITOR',
  'PYTHONPATH',
  'NODE_PATH',
  'GOPATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
];
```

Allow user to configure additional vars via preferences.

---

## Implementation Plan

### Files to Modify

| File | Changes |
|------|---------|
| `src/session-manager.ts` | Capture env on create, restore on resume |
| `src/storage.ts` | Add `storeSessionEnv()`, `loadSessionEnv()` |
| `src/types.ts` | Add env-related types |
| `src/preferences.ts` | Add `envWhitelist` preference (optional) |

### API Changes

None - this is transparent to the client.

### Data Format

`~/.caco/sessions/<id>/env.json`:
```json
{
  "capturedAt": "2026-02-07T12:00:00Z",
  "env": {
    "PATH": "/usr/bin:/home/user/.venv/bin",
    "VIRTUAL_ENV": "/home/user/.venv",
    "NODE_ENV": "development"
  }
}
```

---

## SDK Active vs Stale Session Detection

### What the SDK Stores

Each session in `~/.copilot/session-state/<id>/` contains:

```
workspace.yaml     # Session metadata
events.jsonl       # Event history  
checkpoints/       # Checkpoint data
files/             # File cache
```

**workspace.yaml** contains:
```yaml
id: <session-id>
summary_count: 0
created_at: 2026-01-25T22:27:47.321Z
updated_at: 2026-01-25T22:27:48.128Z
summary: What model are you?
```

**events.jsonl first line** (session.start event):
```json
{
  "type": "session.start",
  "data": {
    "sessionId": "...",
    "startTime": "2026-02-07T07:58:24.161Z",
    "selectedModel": "claude-sonnet-4.5",
    "context": {
      "cwd": "/home/user/project",
      "gitRoot": "/home/user/project",
      "branch": "master"
    }
  }
}
```

### SDK API for Session Metadata

```typescript
interface SessionMetadata {
  sessionId: string;
  startTime: Date;
  modifiedTime: Date;
  summary?: string;
  isRemote: boolean;
}

const sessions = await client.listSessions();
```

### Detection Capabilities

| What | How | Available |
|------|-----|-----------|
| Session exists | File exists in session-state | ✓ |
| Last modified | `modifiedTime` from listSessions() | ✓ |
| Original cwd | Parse session.start event | ✓ |
| Git branch at creation | Parse session.start event | ✓ |
| Is currently active | Check `activeSessions` map | ✓ (Caco-side) |
| Original environment | **NOT STORED** by SDK | ✗ |

### What "Stale" Means

A session is **stale** when:
1. The cwd no longer exists
2. The git repo was deleted/moved
3. The environment setup has changed
4. Time-based: session hasn't been used in X days

**SDK provides no staleness detection** - we must implement it ourselves.

---

## Environment Setup Scripts

### Use Case: Complex Enterprise Environments

Real-world scenario: Office environments with legacy development systems requiring:
- Multiple toolchain versions (gcc 4.8, gcc 7, gcc 11)
- Proprietary build systems with deep PATH manipulation
- License server connections
- Network drive mounts
- VPN state dependencies
- Module systems (`module load xyz`)

### Static Environment Capture Limitations

Simple env snapshot fails because:
1. Paths may include temporary mount points
2. License tokens expire
3. VPN changes network routes
4. Module system modifies env dynamically

### Proposed Solution: Environment Setup Scripts

Instead of (or in addition to) storing static env snapshots, allow users to specify **executable scripts** that recreate the environment.

#### Configuration

`~/.caco/sessions/<id>/env-setup.sh` (user-created):
```bash
#!/bin/bash
# Environment setup for this session

# Load company module system
source /opt/modules/init/bash
module load gcc/7.5
module load cmake/3.21

# Activate Python environment
source ~/projects/myproject/.venv/bin/activate

# Set project-specific vars
export BUILD_TYPE=debug
export LICENSE_SERVER=lic.company.internal:27000

# Connect to VPN if needed (interactive)
# vpn-connect --profile office
```

#### When to Run the Script

Since each session has its own CopilotClient subprocess with isolated environment, the question is simple:

**Run the script when creating/resuming a CopilotClient for a session.**

Each CopilotClient is independent. There's no "switching" between environments - each session's subprocess has its own env from the start.

```typescript
async function getClientForSession(sessionId: string, cwd: string): Promise<CopilotClient> {
  // Get this session's environment (script or static)
  const env = await prepareEnvironment(sessionId);
  
  // Create client with session-specific env
  // This subprocess is completely isolated from other sessions
  return new CopilotClient({ cwd, env });
}
```

**Caching consideration:** If a session is already active (CopilotClient running), its env is already set in that subprocess. No need to re-run scripts until the session is stopped and resumed.

#### Script Execution: What We Can and Can't Do

##### What the SDK Provides

```typescript
new CopilotClient({
  cwd: string,
  env: Record<string, string | undefined>  // Static key-value pairs
});
```

The SDK accepts a **static env object**. It does NOT:
- Run scripts
- Execute shell commands
- Support dynamic env generation

##### What Caco Must Do

**Before** creating the CopilotClient, Caco must:
1. Run the setup script
2. Capture the resulting environment
3. Pass it as `env` to CopilotClient

```typescript
async function prepareEnvironment(sessionId: string): Promise<Record<string, string>> {
  const scriptPath = getEnvSetupScript(sessionId);
  
  if (!scriptPath || !existsSync(scriptPath)) {
    return {};  // No custom env, use Caco's process.env (SDK default)
  }
  
  // Run script and capture resulting environment
  // The script runs in its own subprocess, sources files, loads modules, etc.
  // We capture the final env state after all that completes.
  const { stdout, stderr, exitCode } = await execAsync(
    `bash -c 'source ${scriptPath} && env'`,
    { timeout: 30000 }  // 30s timeout
  );
  
  if (exitCode !== 0) {
    console.error(`Env setup script failed: ${stderr}`);
    throw new Error(`Environment setup failed for session ${sessionId}`);
  }
  
  return parseEnvOutput(stdout);
}
```

##### Limitation: Side Effects Don't Transfer

The script runs in a **temporary subprocess**. When it exits:

| Survives | Lost |
|----------|------|
| Environment variables | Running processes (daemons) |
| PATH modifications | Network connections |
| Exported vars | File locks |
| | In-memory state |

**Example problem:**
```bash
# env-setup.sh
vpn-connect --background  # Starts VPN daemon
export VPN_CONNECTED=true
```

The VPN daemon dies when the script subprocess exits. Only `VPN_CONNECTED=true` transfers to CopilotClient.

##### Workarounds for Side Effects

**Option 1: Pre-session setup (manual)**
User runs setup outside Caco, then creates session:
```bash
# User's terminal
vpn-connect
module load gcc/7.5
# Now start Caco or create session via API
```

**Option 2: Agent-invoked tooling**
Agent runs setup commands via bash tool during session:
```
Agent: I'll set up the build environment.
[bash] module load gcc/7.5
[bash] source /opt/setup-toolchain.sh
```

**Tradeoff:** This happens after CopilotClient starts, so the agent's subprocess gets the setup, but this is suboptimal:
- Extra round-trip
- User must instruct agent each time
- Can't use for Caco→SDK subprocess env (only agent shell commands)

**Option 3: Wrapper script for CopilotClient**
Instead of passing `env`, we could modify how SDK spawns its subprocess... but this would require SDK changes or hacks.

##### Recommended Approach

For **environment variables only** (PATH, VIRTUAL_ENV, etc.):
- Use env-setup.sh script, Caco runs it and captures env
- Works perfectly

For **persistent processes** (VPN, license servers, etc.):
- Document as prerequisite: "Ensure VPN connected before resuming session X"
- Or use validation: check if required services are running before resume

```typescript
async function validatePrerequisites(sessionId: string): Promise<ValidationResult> {
  const config = loadSessionConfig(sessionId);
  const warnings: string[] = [];
  
  // Check for required processes/services
  if (config.requiresVpn) {
    const vpnRunning = await checkVpnStatus();
    if (!vpnRunning) {
      warnings.push('VPN connection required but not active');
    }
  }
  
  return { valid: warnings.length === 0, warnings };
}
```

#### How It Works

1. **On session resume:**
   ```typescript
   async function prepareEnvironment(sessionId: string): Promise<Record<string, string>> {
     const scriptPath = `~/.caco/sessions/${sessionId}/env-setup.sh`;
     
     if (existsSync(scriptPath)) {
       // Run script and capture resulting environment
       const result = await execAsync(`bash -c 'source ${scriptPath} && env'`);
       return parseEnvOutput(result.stdout);
     }
     
     // Fall back to static env.json
     return loadSessionEnv(sessionId) ?? process.env;
   }
   ```

2. **Script output parsing:**
   ```typescript
   function parseEnvOutput(output: string): Record<string, string> {
     const env: Record<string, string> = {};
     for (const line of output.split('\n')) {
       const idx = line.indexOf('=');
       if (idx > 0) {
         env[line.slice(0, idx)] = line.slice(idx + 1);
       }
     }
     return env;
   }
   ```

#### Agent-Assisted Script Creation

When user creates session in a complex environment, agent can help:

```
User: "Set up this session for our legacy build system"

Agent: I'll create an environment setup script for this session.
       What commands do you typically run to set up your build environment?

User: "I run 'source /opt/setup-gcc7.sh' and 'module load cmake'"

Agent: [Creates env-setup.sh with those commands]
       Created ~/.caco/sessions/<id>/env-setup.sh
       This script will run automatically when resuming this session.
```

#### Per-CWD vs Per-Session Scripts

| Level | Location | Use Case |
|-------|----------|----------|
| Per-session | `~/.caco/sessions/<id>/env-setup.sh` | Session-specific config |
| Per-cwd | `<cwd>/.caco-env.sh` | Project-level setup |
| Global | `~/.caco/env-setup.sh` | User defaults |

**Execution order:** Global → Per-cwd → Per-session (later overrides earlier)

#### Security Considerations

1. **Script review**: User must create/approve scripts (not auto-generated from env)
2. **Execution control**: Scripts run in subprocess, not current shell
3. **No secrets in scripts**: Scripts should `source` external files, not contain secrets
4. **Timeout**: Scripts have execution timeout (default: 30s)

#### Validation Before Resume

```typescript
interface EnvValidation {
  valid: boolean;
  warnings: string[];
  scriptExists: boolean;
  scriptLastModified?: Date;
}

async function validateSessionEnv(sessionId: string): Promise<EnvValidation> {
  const script = getEnvSetupScript(sessionId);
  const warnings: string[] = [];
  
  if (script) {
    // Check script is readable/executable
    if (!canExecute(script)) {
      warnings.push(`Setup script not executable: ${script}`);
    }
    
    // Optionally: dry-run to check for errors
    const dryRun = await execAsync(`bash -n ${script}`);
    if (dryRun.exitCode !== 0) {
      warnings.push(`Script has syntax errors: ${dryRun.stderr}`);
    }
  }
  
  return {
    valid: warnings.length === 0,
    warnings,
    scriptExists: !!script,
    scriptLastModified: script ? getModTime(script) : undefined
  };
}
```

---

## Complexity & Risk Assessment

### Current Reality Check

The SDK **does spawn subprocesses** for copilot-cli (confirmed via `ps aux`):
```
node .../copilot --server --log-level debug --stdio
```

So `CopilotClient({ env })` would work. But implementing env scripts adds significant complexity.

### Cost-Benefit Analysis

| Approach | Complexity | Bug Risk | Value |
|----------|------------|----------|-------|
| Do nothing | 0 | 0 | Sessions inherit Caco's env (current) |
| Static env capture | Low | Low | Snapshot env at session creation |
| Env scripts | **High** | **High** | Dynamic env recreation |

### Why Env Scripts Are a Bug Farm

1. **Shell parsing edge cases**
   - Multi-line values
   - Special characters in values  
   - Binary data in env
   - Values containing `=`

2. **Script execution issues**
   - Timeout handling
   - Error recovery
   - Partial success states
   - Non-bash shells

3. **State synchronization**
   - When to invalidate cached env?
   - Script file watching
   - Race conditions on resume

4. **Testing complexity**
   - Mock shell execution
   - Platform differences (bash versions)
   - CI environment differences

### Simpler Alternatives

#### Alternative 1: Agent-Driven Setup (Zero Caco Changes)

Let the agent handle environment setup through existing bash tool:

```
User: Resume my GCC 7 session

Agent: [checks session metadata]
       This session uses the legacy build environment.
       [bash] source /opt/modules/init/bash && module load gcc/7.5
       [bash] export CC=gcc-7 CXX=g++-7
       Environment ready. How can I help?
```

**Pros:**
- No Caco code changes
- Agent has full visibility into what it's doing
- Works with any shell commands
- Self-documenting (visible in chat)

**Cons:**
- Requires agent cooperation
- Extra round-trip on each resume
- Env applies to agent's bash commands, not SDK subprocess

#### Alternative 2: Static Env Capture Only (Low Complexity)

Just capture `process.env` at session creation, restore on resume:

```typescript
// On create
storeSessionEnv(sessionId, process.env);

// On resume  
const env = loadSessionEnv(sessionId) ?? undefined;
const client = new CopilotClient({ cwd, env });
```

**Pros:**
- Simple, testable
- No shell execution
- No parsing edge cases

**Cons:**
- Stale env (venv deleted, PATH changed)
- Large env.json files
- No dynamic environments (module systems)

#### Alternative 3: Document Best Practices (Zero Caco Changes)

For complex environments, recommend users:
1. Start Caco from within their configured environment
2. Use systemd/launchd with `Environment=` directives
3. Create wrapper scripts for Caco startup

```bash
#!/bin/bash
# start-caco-legacy.sh
source /opt/modules/init/bash
module load gcc/7.5 cmake/3.21
cd ~/caco && ./start.sh
```

### Recommendation

**Start with Alternative 2 (static capture)**, defer scripts indefinitely.

Rationale from code-quality.md:
- "Can we get 90% of the requirement with 10% of the code?"
- "complexity - the greatest enemy!"
- "wrong abstraction - expensive forever!"

Static env capture handles the common case (Python venv, PATH mods) without shell execution complexity.

---

---

## Copilot-CLI Limitations (Interview Findings)

Direct interview with copilot-cli (via agent introspection) reveals:

### What Copilot-CLI CANNOT Do

| Limitation | Implication |
|------------|-------------|
| Cannot read `copilot-instructions.md` on resume | Must inject context differently |
| May not know it was invoked with `--resume`/`--continue` | Cannot self-trigger env setup |
| Has `shellId` but forgets which does what | Shell state is ephemeral |
| No reliable Windows env setup (direnv fails) | Platform-specific workarounds |

### What Copilot-CLI DOES Have

| Capability | Note |
|------------|------|
| `shellId` with cached shell environments | Multiple shells possible, but context unclear |
| Tool execution (bash commands) | Agent can run setup, but must be instructed |

### Conclusion from Interview

> "A combination of copilot-instructions.md telling of environment setup needs, and a failure-to-setup flow is most reliable."

The SDK provides **no hooks between client creation and first request**. We cannot:
- Run initialization code before the agent sees the first message
- Modify the system message on resume (only on create)
- Inject context automatically on session resume

---

## Proposed Scheme: Resume-Aware First Message

Since copilot-cli doesn't know it's resuming, but **Caco knows**, we can inject context into the first message after resume.

### The Insight

```typescript
// Caco's send() method in session-manager.ts
async send(sessionId: string, message: string, options: SendOptions) {
  // WE control the prompt before it reaches the SDK!
  // We can prepend context when resuming
}
```

### Implementation: Session Resume Context

Track whether a session was just resumed, and prepend context on first send:

```typescript
// New field in ActiveSession
interface ActiveSession {
  cwd: string;
  session: CopilotSessionInstance;
  client: CopilotClientInstance;
  needsResumeContext: boolean;  // <-- New
}

// In resume()
this.activeSessions.set(sessionId, { 
  cwd, session, client, 
  needsResumeContext: true 
});

// In send()
async send(sessionId: string, message: string, options: SendOptions) {
  const active = this.activeSessions.get(sessionId);
  
  if (active.needsResumeContext) {
    message = prependResumeContext(sessionId, message);
    active.needsResumeContext = false;
  }
  
  return session.sendAndWait({ prompt: message, ...options });
}
```

### Resume Context Template

```typescript
function prependResumeContext(sessionId: string): string {
  const meta = getSessionMeta(sessionId);
  
  return `[SESSION RESUMED]
This is a resumed session. Previous shell state may be lost.

If this session requires specific environment setup:
1. Check that required tools are available (e.g., verify \`gcc --version\`)
2. Re-run setup commands if needed (e.g., \`source .venv/bin/activate\`)
3. Confirm environment is correct before proceeding with work

Session CWD: ${meta.cwd}
${meta.envSetupHint ? `Environment hint: ${meta.envSetupHint}` : ''}

---

`;
}
```

### Per-Session Environment Hints

Store environment setup hints with session metadata:

```json
// ~/.caco/sessions/<id>/meta.json
{
  "cwd": "/home/user/project",
  "envSetupHint": "Run 'source /opt/modules/init/bash && module load gcc/7.5' before building",
  "envScript": "~/.caco/sessions/<id>/env-setup.sh"
}
```

### User Flow for Complex Environments

1. **Create session** in complex environment
2. **Agent documents** environment setup (via instructions or hints)
3. **Session is stopped** (CopilotClient subprocess dies)
4. **Session resumed** - Caco injects resume context
5. **Agent sees context**, re-initializes shell environment
6. **Agent confirms** environment is ready

### Failure-to-Setup Flow

When environment setup fails:

```typescript
// Agent attempts setup, fails
[bash] module load gcc/7.5
// Error: module: command not found

// Agent should recognize failure and inform user:
"I couldn't load the gcc/7.5 module. This session requires the legacy 
build environment. Please run this session from a terminal that has 
the module system initialized."
```

This matches the interview finding: "failure-to-setup flow is most reliable."

### Advantages of This Scheme

| Benefit | Description |
|---------|-------------|
| No SDK changes | Works with current SDK |
| Agent-aware | Agent knows it's resuming |
| Graceful degradation | Can detect and report failures |
| Platform-agnostic | Works on Windows, Linux, macOS |
| Self-documenting | Instructions visible in chat |

### Limitations

| Limitation | Mitigation |
|------------|------------|
| Extra round-trip | Minimal - just first message |
| Agent must cooperate | Explicit context makes this reliable |
| Can't fix before first send | By design - user sees what's happening |

---

## Open Questions

1. **Full snapshot vs whitelist?** Security vs completeness tradeoff
2. **Stale env handling?** Warn user? Auto-update? Require confirmation?
3. **Per-session or per-cwd?** Should all sessions in same cwd share env?
4. **Scheduled sessions?** Should they capture env at schedule creation time?
5. **Script vs snapshot?** Which is default? Can they coexist?
6. **Interactive scripts?** Allow user input during env setup?
7. **Resume context verbosity?** How much context to inject without overwhelming?

---

## Status

- [x] Research SDK capabilities
- [x] Document current architecture  
- [x] Write spec
- [x] Document active vs stale detection
- [x] Design environment scripts feature
- [x] Document copilot-cli limitations (from interview)
- [x] Design resume-aware first message scheme
- [ ] Implement resume context injection
- [ ] Implement env setup hints storage
- [ ] Implement Phase 1 (static env capture) - optional
- [ ] Implement Phase 2 (env restore) - optional
- [ ] Implement Phase 3 (validation) - optional
- [ ] Implement Phase 4 (env scripts) - deferred indefinitely
