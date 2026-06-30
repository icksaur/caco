# Browser launch reliability (caco_browser_ensure_running)

Focused fix spec. Parent design: `docs/spec-browser-automation.md`.

## Problem

`caco_browser_ensure_running` is flaky on Windows: it intermittently fails with

```
{"ok":false,"reason":"launch_failed",
 "message":"Timed out after 30000ms waiting for CDP at http://127.0.0.1:9222",
 "diagnostics":""}
```

When it fails there is **no diagnostic info**, so the operator falls back to running
`scripts/start-browser.ps1` by hand. Direct manual launch of Edge with the same flags
**always works**, so the launch mechanics are sound — the failure is a race/handoff
during cold launch plus a total loss of diagnostics.

## Root cause

Three independent defects. **Defect 0 (below) was the dominant cause of the cold-launch
failures**; defects 1 and 2 compounded the problem by making failures blind and
non-self-healing. Defect 0 was found during live verification after A/B were in place.

### Defect 0 — `detached:true` silently breaks the Windows helper spawn
`spawnHelper()` (`src/browser-connection.ts`) launched the powershell helper with
Node's `spawn(..., { detached: true, stdio: 'ignore', windowsHide: true })`. On Windows,
a **detached + windowsHide** powershell child fails to initialize its console host and
**exits 0 in ~120 ms WITHOUT running the script body at all** — no Edge spawned, no log
written, yet a clean exit code. `ensureRunning` therefore saw a successful helper exit,
re-read config, and blocked the full 30 s in `waitForCdp` before failing blind.

Proven by bisection: replicating the *exact* Node args via `Start-Process` always worked
(Edge up, CDP ready ~4 s, logs written), and flipping the lone `spawn` option
`detached:true` → `false` (everything else identical) made the Node-spawned helper run
correctly every time. The helper does not need Node to detach it: it launches Edge via
its own `Start-Process` (fully independent) and polls CDP readiness before exiting, so
Edge survives both the helper's and Node's exit.

**Fix:** `detached: !isWindows` (and gate `child.unref()` on `!isWindows`) in
`spawnHelper`. Non-Windows keeps `detached:true` + `unref()` (the `.sh` helper detaches
Edge via `setsid`/`nohup`), preserving the already-working Linux/Mac behavior.

### Defect 1 — diagnostics discarded on timeout
`ensureRunning()` (`src/browser-connection.ts`) captures the helper's log output in
`diagnostics`, then calls `waitForCdp(updated.cdpUrl, launchTimeoutMs)`. On timeout
`waitForCdp` throws a **fresh** `LaunchFailedError(msg, '')` with an empty diagnostics
string. The captured helper log (which port was chosen, the Edge path, any helper error)
is thrown away. That is exactly the empty `"diagnostics":""` seen above.

### Defect 2 — helper is fire-and-forget; never verifies the port opened
`scripts/start-browser.ps1` does:

```powershell
Start-Process -FilePath $edge -ArgumentList $edgeArgs -WindowStyle $windowStyle | Out-Null
Write-Log "Launched Edge mode=$Mode port=$Port"
exit 0
```

It logs "Launched" and exits 0 **without checking that Edge survived or that the CDP
port came up**. On a workstation with Edge "startup boost" / background brokers (the
operator's box has ~40 live `msedge.exe`), a newly spawned debug Edge can be **absorbed
by the running browser broker and exit immediately** before opening port 9222 — even
with a dedicated `--user-data-dir`. The helper still reports success (exit 0, log says
"Launched"), so Node blocks for the full 30 s `waitForCdp` and then fails blind.

A secondary divergence: `docs/spec-browser-automation.md` says the helper consults
`<profile>/DevToolsActivePort` to decide reuse-vs-fresh-port, but the script never does
— it only does a `Test-PortFree` increment. A stale debug Edge holding 9222 without
serving CDP would push the helper to a different port; Node re-reads config so this is
handled, but a stale `SingletonLock` in the profile can make a fresh Edge try to hand
off to a dead instance and exit.

## Goals

1. When launch fails, the tool result carries **actionable diagnostics** (which port,
   Edge path, whether the process died, the helper log) — never empty.
2. Make cold launch **self-healing and authoritative**: the helper verifies Edge is
   actually CDP-reachable before reporting success, cleans stale profile locks, and
   fails fast with a clear reason instead of letting Node time out blind.
3. No change to the operator/agent contract, the tool surface, or the
   already-working idempotent reuse path.

## Design

### Change 0 — do not detach the helper spawn on Windows (defect 0, the fix)
In `spawnHelper`, pass `detached: !isWindows` and only `child.unref()` on non-Windows.
This makes the Windows powershell helper actually run its script body. Changes A and B
remain valuable (rich diagnostics + authoritative readiness), but this is the change that
makes cold launch reliable.

### Change A — thread diagnostics through the timeout (defect 1)
In `ensureRunning`, wrap the `waitForCdp` call so a timeout rethrows a
`LaunchFailedError` that **includes the captured helper diagnostics** plus a short
runtime note (intended cdpUrl, elapsed). Also append a one-line hint pointing at the
helper log path. Belt-and-suspenders: even if the helper still exits 0, the operator
sees the helper's own log in the failure.

### Change B — make the helper authoritative (defect 2)
Rework `scripts/start-browser.ps1` so that after `Start-Process … -PassThru`:

1. **Stale-lock cleanup (pre-launch):** if no live `msedge.exe` is using the dedicated
   profile, remove stale `SingletonLock`, `SingletonCookie`, `SingletonSocket`, and a
   stale `DevToolsActivePort` from the profile dir. This prevents handoff to a dead
   instance.
2. **Reuse check (pre-launch):** if `http://127.0.0.1:$Port/json/version` already
   answers, log "reusing existing CDP on $Port", write config, `exit 0` — don't spawn
   a duplicate Edge.
3. **Launch with `-PassThru`** to capture the spawned process; log its PID.
4. **Readiness poll (post-launch):** for up to `$ReadyTimeoutSec` (default 25 s, kept
   under Node's 30 s `launchTimeoutMs`):
   - if the captured Edge process has exited early → log "Edge exited early (handoff/
     startup-boost absorption); retrying once with a fresh profile-scoped launch" →
     retry **once**; if the retry also dies, log + `exit 6`.
   - if `/json/version` answers → log "CDP ready on $Port (pid …)" → `exit 0`.
   - else sleep 250 ms and repeat.
   - on timeout → log "CDP never came up on $Port within ${ReadyTimeoutSec}s" →
     `exit 7`.

The helper now resolves only once CDP is genuinely up (fast happy path) or fails fast
with a specific exit code and a rich log. `spawnHelper` already surfaces a non-zero exit
as `LaunchFailedError(message, diagnostics=helper.log)`, so the failure reaches the tool
result fully diagnosed. Node's subsequent `waitForCdp` becomes a near-instant confirm.

### Non-changes
- Tool schema, error reasons, and `ensureRunning`'s reuse/in-flight-dedup logic are
  unchanged.
- `start-browser.sh` (Linux, the path that already works) gets the same readiness-poll
  treatment for parity but is lower priority; the Windows path is the fix that matters.

## Risks and Mitigations
- **Helper now lives ~up to 25 s instead of exiting instantly.** It is detached and
  `unref`'d; `spawnHelper` already awaits child exit, so this only means the happy path
  resolves when CDP is truly ready (a feature, not a regression). Worst case is bounded
  by `$ReadyTimeoutSec` < Node's 30 s.
- **One automatic retry could spawn two Edges.** Guarded: retry only fires when the
  first captured process has already exited; we never have two live debug Edges.
- **Deleting Singleton files while another Edge legitimately uses the profile** — guarded
  by the "no live msedge using this profile" check before any deletion.

## Acceptance
- Build green (`npm run build`).
- Live: kill any debug Edge, call `caco_browser_ensure_running` cold → succeeds within a
  few seconds; `started:true`.
- Force-fail (e.g. point Edge path bad / simulate absorption) → tool returns
  `launch_failed` with **non-empty** diagnostics naming port + helper log.
- Idempotent path unchanged: second call returns `started:false` immediately.
- `caco_browser_navigate` to a page works after a cold ensure.

## Status
- [x] Change 0 — Windows spawn no longer detached (`src/browser-connection.ts`) — **the fix**
- [x] Change A — diagnostics threading (`src/browser-connection.ts`)
- [x] Change B — authoritative helper (`scripts/start-browser.ps1`)
- [x] sh parity (`scripts/start-browser.sh`)
- [x] build + live verify — cold launch `started:true` CDP ~4s; reuse `started:false`;
      navigate to example.com → 200; success path now carries helper diagnostics

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Fix Windows spawn (`detached: !isWindows`) | `src/browser-connection.ts` | visual: cold launch `started:true` within ~5 s |
| 2 | Thread diagnostics through timeout | `src/browser-connection.ts` | force-fail → non-empty `diagnostics` field in result |
| 3 | Authoritative helper with readiness poll + lock cleanup | `scripts/start-browser.ps1` | helper exits only after CDP answers or emits specific exit code |
| 4 | sh parity (readiness poll) | `scripts/start-browser.sh` | build green; existing Linux path unaffected |
