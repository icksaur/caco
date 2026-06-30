# Spec: cross-platform `caco.sh` (Windows support)

## Goals

`caco.sh(command)` — the shell escape hatch inside `caco_run_workflow` (the only way
the agent runs shell since C1 removed the `bash` built-in) — must work on **Windows**, not
just Unix. Today it routes through Node `exec`, whose default shell is `cmd.exe` on Windows,
so every bash idiom the model writes (`2>&1 | tail`, `&&`, `setsid`, `rg`) fails there.

Two halves, both required:
1. **Execution:** run the command in a real, capable shell per platform — **bash on Unix,
   PowerShell on Windows** (the user's explicit choice; `cmd.exe` is too weak).
2. **Signalling:** tell the model which **dialect** to write, in the workflow tool
   description and facade summary, so it emits PowerShell on a Windows host and bash on Unix.
   Without this the model writes bash on Windows and commands fail.

## Hard requirements

- Works on a vanilla Windows Node install (PowerShell is always present: `powershell.exe`
  in System32; prefer `pwsh` if on PATH).
- Never throws on non-zero exit (preserve current contract: returns `{ stdout, stderr, code }`).
- Platform detection is **mockable and unit-tested** for `win32` even though CI/dev is Linux
  (we cannot run a real Windows shell here, so the selection logic must be a pure function
  tested by simulating `platform: 'win32'` + a fake PATH).
- No behavioural regression on Unix: bash commands keep working exactly as before.
- The dialect signal is computed from the **host** platform (the server and the workflow
  child both run on the host), surfaced once in the tool description / facade summary.

## Current behaviour (to change)

`src/workflow/facade.ts`:
```ts
const execAsync = promisify(exec);
async sh(command) {
  try { const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer }); return { stdout, stderr, code: 0 }; }
  catch (e) { /* return err.stdout/stderr/code */ }
}
```
`exec` uses the OS default shell (`/bin/sh` Unix, `cmd.exe` Windows). The workflow tool
DESCRIPTION (`src/workflow/tool.ts`) and `FACADE_API_SUMMARY` hardcode bash idioms
(`setsid … &`, `| tail -3`); `prompts.ts` workflowNudge is dialect-neutral but unlabelled.

## Non-goals / known limitations

- **PowerShell only on Windows** — `cmd.exe`, Git Bash/MSYS, and ComSpec are intentionally
  bypassed on `win32`. WSL reports `linux` (bash is correct there). Git-Bash-on-Windows Node
  reports `win32`, so it gets PowerShell, consistent with the explicit goal.
- **`.cmd`/`.bat` shims are not resolved** — `execFile` does not route through `cmd.exe`, so
  PATH resolution returns only real executables (`pwsh.exe`/`powershell.exe`), then the
  deterministic `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, then a bare
  `powershell.exe` (execFile PATH lookup).
- **Windows descendant reaping is NOT solved here.** `runner.ts` bounds a workflow with a
  timeout by killing the workflow child (Unix process-group `kill(-pid)` with a `child.kill`
  fallback). On Windows, negative-PID group signalling does not apply, so a detached
  PowerShell/native *grandchild* may outlive the killed child. Foreground commands are still
  bounded (the child dies), but a robust Windows long-running-command kill (job objects /
  `taskkill /T`) is a **separate requirement**, out of scope for the dialect work.
- Very long command strings remain subject to OS command-line limits (PowerShell may hit the
  Windows limit sooner than Unix); not new, not addressed here.

## Design

### New module `src/workflow/shell.ts` (pure + cached)

```ts
export type ShellDialect = 'bash' | 'powershell' | 'sh';
export interface ShellSpec {
  file: string;        // executable to spawn (absolute when resolved on PATH, else bare name)
  flagArgs: string[];  // args before the command string: bash ['-c']; pwsh ['-NoProfile','-NonInteractive','-Command']
  label: string;       // model-facing: 'bash' | 'PowerShell' | 'sh'
  dialect: ShellDialect;
}
export interface ResolveOpts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (absPath: string) => boolean; // injected for tests
}
export function resolveShell(opts: ResolveOpts): ShellSpec;  // pure
export function getHostShell(): ShellSpec;                   // cached real resolution (process.* + existsSync)
export interface ShellGuidance { label: string; banner: string; detachExample: string; tailExample: string; }
export function shellGuidance(spec: ShellSpec): ShellGuidance;
```

`resolveShell`:
- **win32:** look up `pwsh` then `powershell` on PATH (trying `.exe`/`.cmd`/`` extensions);
  fall back to bare `powershell.exe` (execFile resolves via PATH). `flagArgs =
  ['-NoProfile','-NonInteractive','-Command']`, `label 'PowerShell'`, `dialect 'powershell'`.
- **else:** `bash` on PATH → `flagArgs ['-c']`, `label 'bash'`; else `sh` (or `/bin/sh`) →
  `label 'sh'`. `dialect` accordingly.

`shellGuidance` returns dialect-specific snippets so the tool description is correct per host:
- `banner`: "caco.sh runs in {label} on this host — write {label} syntax (not {other})."
- `detachExample`: Unix `setsid <cmd> >log 2>&1 < /dev/null &`; Windows
  `Start-Process -NoNewWindow -FilePath <cmd> -RedirectStandardOutput log.txt`.
- `tailExample`: Unix `npm test 2>&1 | tail -3`; Windows `npm test 2>&1 | Select-Object -Last 3`.

### `caco.sh` rewrite (`facade.ts`)

Use `execFile` with the explicit shell + `[...flagArgs, command]` (the command is one argv
element, so the chosen shell parses it — no double-quoting hazard, an improvement over
`exec`). Same try/catch → `{ stdout, stderr, code }`; non-zero exit and maxBuffer overflow
return a code, never throw. Remove the now-unused `exec`/`execAsync`.

### Signalling

- `FACADE_API_SUMMARY` (facade.ts): the `caco.sh` line names the host shell, e.g.
  `caco.sh(command) -> { stdout, stderr, code } (runs in PowerShell on this host; write
  PowerShell syntax). Never throws on non-zero exit.` Computed once at module load from
  `getHostShell()`.
- Tool DESCRIPTION (tool.ts): build from `shellGuidance(getHostShell())` — prepend the
  `banner`, and use `detachExample`/`tailExample` instead of the hardcoded bash strings.
- `prompts.ts` workflowNudge: append the one-line `banner` so the system prompt also states
  the dialect.

## Considerations

- **Can't run Windows here.** Correctness on Windows rests on (a) the pure `resolveShell`
  unit-tested with `platform:'win32'` + fake PATH (asserts pwsh-preferred, powershell
  fallback, correct flags/label), and (b) `shellGuidance` unit-tested for both dialects.
  The live Unix path is covered by an integration test that runs a real bash command.
- **PowerShell `2>&1`** works (stream merge); pipes work; `&&` works in pwsh 7+ and `;`
  everywhere — so the batching guidance stays valid. Only `tail`/`setsid`/`rg`-absent are
  dialect-specific, handled by guidance + the existing `grepCore` rg→JS fallback.
- **`-NonInteractive`** prevents PowerShell from blocking on prompts (interactive stdin was
  already unsupported through the SDK; documented, not regressed).
- **execFile PATH resolution:** passing a bare `powershell.exe`/`bash` lets execFile search
  PATH; resolving to an absolute path when found avoids a second lookup and is deterministic.
- **No mid-session state.** Pure facade + description change; host shell resolved once.

## Acceptance

- `resolveShell` unit tests: win32 → prefers `pwsh` when present, falls back to
  `powershell` (with correct `flagArgs`/`label`/`dialect`); linux/darwin → `bash` when
  present, `sh` fallback; `flagArgs` exact for each.
- `shellGuidance` unit tests: powershell vs bash produce the right banner + detach + tail
  snippets.
- Facade integration (Unix CI): `caco.sh('printf hi')` → `{ stdout:'hi', code:0 }`;
  `caco.sh('exit 3')` → `code:3`, no throw; a bash pipeline still works.
- Description/summary contain the host dialect label (assert `getHostShell().label` appears).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan

1. `src/workflow/shell.ts`: `resolveShell` + `getHostShell` + `shellGuidance`; unit tests
   first (win32/linux/darwin matrix + guidance dialects).
2. Rewrite `caco.sh` to `execFile` the resolved shell; remove `exec`/`execAsync`; facade
   integration tests (run/exit-code/pipeline on the host).
3. Dialect signalling: `FACADE_API_SUMMARY` sh line, tool DESCRIPTION via `shellGuidance`,
   prompts workflowNudge banner.
4. Gates; commit; push origin + backup.
