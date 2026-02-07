# Environment Control

## Problem

When a session is **resumed**, copilot-cli:
- Does NOT know it was invoked with `--resume`
- Does NOT re-read `copilot-instructions.md`
- Loses its `shellId` context (which shell had which environment)
- Cannot reliably recreate complex environments (module systems, direnv, etc.)

Result: Resumed sessions may attempt work with stale/missing environment setup.

## Solution: Resume Context Injection

**Caco knows when a session is resumed. The agent doesn't. Tell it.**

On first message after resume, prepend context:

```
[SESSION RESUMED]
This is a resumed session. Your shell state has been reset.
Re-run any environment setup commands before proceeding.

Session directory: /home/user/project
Environment hint: source .venv/bin/activate && module load gcc/7.5
---

<user's actual message>
```

The agent then:
1. Sees it's resuming
2. Has explicit setup instructions
3. Runs setup commands via bash tool
4. Confirms environment before proceeding

### Why This Works

| Limitation | Solution |
|------------|----------|
| SDK has no hook between create and first send | Prepend to first message |
| Can't modify system message on resume | Use message prefix |
| copilot-cli forgets shell context | Explicit reinit instructions |

### Implementation

Changes to `src/session-manager.ts`:

1. Track resume state in `ActiveSession`:
   ```typescript
   interface ActiveSession {
     // ... existing fields
     pendingResumeContext: boolean;
   }
   ```

2. Set flag in `resume()` → `true`, in `create()` → `false`

3. Inject context in `send()` and `sendStream()`:
   ```typescript
   if (active.pendingResumeContext) {
     message = buildResumeContext(sessionId, cwd) + message;
     active.pendingResumeContext = false;
   }
   ```

### Per-Session Environment Hints

Stored in `~/.caco/sessions/<id>/meta.json` as `envHint` field.

Set via:
- `PATCH /api/sessions/:id` with `{ "envHint": "..." }`
- Manual JSON edit

---

## Status

- [x] Document problem and solution
- [x] Implement `pendingResumeContext` flag
- [x] Implement `buildResumeContext()` function  
- [x] Add `envHint` to SessionMeta and PATCH API
- [x] Test resume flow

---

## Research

For background research and alternative approaches considered, see [research/environments-research.md](research/environments-research.md).
