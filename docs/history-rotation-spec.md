# History Rotation Spec

Make cold-resume of "mega-sessions" sub-second by front-truncating the append-only `events.jsonl`, with SDK-load-verified auto-revert. Telemetry + experiment in `cold-open-latency-findings.md`.

## Problem

`events.jsonl` is append-only; the SDK never prunes it. `resumeSession` reads the whole file: **4381ms for 505 MB / 187K lines** (73% of cold open). No SDK version (≤1.0.64) offers pruning/rotation/resume-from-tail; compaction reduces tokens, not disk (this session compacted 40× yet is 505 MB).

## Empirical basis (experiment, real SDK)

| Retained | Size | Resume | OK |
|---|---|---|---|
| full | 505 MB | 4381ms | ✓ |
| start + last compaction_complete→end | 3.2 MB | **40ms** | ✓ |
| start + last 5 turns | 1.4 MB | 29ms | ✓ |
| tail only, NO session.start | 5 MB | — | ✗ "corrupted or incompatible" |

⇒ Front-truncation → **~40ms (<1s met)**. `session.start` (line 1) is **mandatory**. SDK **throws cleanly** on a bad file ⇒ auto-revert is reliable.

## Cut point

Retain `session.start` (line 1) **+ every line from the last `session.compaction_complete` onward**. This resumes fast AND preserves the freshest compaction summary, so the model keeps its compacted memory (soft-correctness, not just resume-ability). Fallback if no compaction event: retain last `MIN_TAIL_EVENTS` (e.g. 4000). Skip rotation entirely if file < `ROTATE_THRESHOLD_BYTES` (e.g. 64 MB) or the cut would save < `MIN_SAVING` (e.g. <50% / <32 MB).

## Operation: `rotateSessionHistory(sessionId)` (new module `src/session-history-rotation.ts`)

Transactional **copy-verify-swap** (revised per review: never expose the live `events.jsonl` to an unverified candidate; never verify on the shared client). Auto-revert is structural — the live file is only ever replaced by an *already-verified* candidate.

1. **Guard + lock:** acquire a per-session **rotation lock** (new state in `SessionManager`, honored by `resume`/`send`/`stop`/auto-repair — see §Locking). Under the lock: session must be inactive (not in `activeSessions`, no in-progress dispatch). `statSync` size; bail if under threshold or savings too small. Bail if a rotation marker/backup already exists (crash recovery, §Crash).
2. **Resolve & persist model FIRST** (fixes model-loss bug, §Correctness): persist via `readModelFromEvents` **semantics** — prefer existing `meta.model` (keeps BYOK/provider-prefixed identity), only fall back to parsed events if meta lacks a model. If meta write fails, **abort** (don't truncate).
3. **Build candidate OUTSIDE the live file:** `events.jsonl.candidate` = `[line0, ...lines.slice(cut)]`, where `cut` = reverse-scan for the last `"type":"session.compaction_complete"` (fallback: last `MIN_TAIL_EVENTS`). Capture `srcStat` (size+mtime) of the live file.
4. **Verify on a STAGED COPY with an ISOLATED client:** stage a throwaway dir (`exp-<id>`) containing the candidate + sibling metadata; `const c = new CopilotClient(...); await c.start(); await c.resumeSession(stagedId, {suppressResumeEvent:true,...}); await c.disconnect(); await c.stop()` in a `finally`. **Do NOT use `SessionManager.resume()` or the shared client** (it would register in `activeSessions`, evict, sync meta, auto-repair, and pollute the live client's session map). On any throw → discard candidate, release lock, return `{ ok:false }` — **the live session is byte-untouched**.
5. **Swap (atomic, re-checked):** still under the lock, re-`statSync` the live file; if it changed since `srcStat` (someone wrote to it) → discard candidate, abort (no data loss). Else: append the pruned head (`lines.slice(1, cut)`) to `events-archive.jsonl` and **fsync**; only if archive append succeeds, `rename(events.jsonl → events.jsonl.prerotate)`, `rename(candidate → events.jsonl)`, then delete `.prerotate`. Write `lastRotatedAt`/`rotatedToBytes` cooldown marker to meta. Release lock. Return `{ ok:true, before, after, savedBytes }`.

The live `events.jsonl` is replaced only by a candidate that **already passed a real SDK load**, and only while no concurrent write has occurred — so there is no window where the live path holds an unverified or partially-written file.

## Locking (new)

`SessionManager` gains a `rotatingSession: Set<sessionId>` (or per-id promise). `resume`/`send`/`stop`/the auto-repair loop check it: a resume requested while rotating **waits** for the rotation promise (it finishes in ms), then proceeds against the swapped file. Rotation only starts when the session is inactive AND not already rotating. Phase 2 rotation holds the lock for the whole operation (not fire-and-forget mid-swap).

## Trigger policy (phased)

- **Phase 1 — manual/explicit.** A `POST /api/sessions/:id/rotate` route + a session-list action. User invokes on a chosen inactive session; result reported. Lets the user **validate coherence** (resume + send a probe; does the model still "remember" via the summary?) on real sessions before any automation. NOTE: `onSessionEnd` is **delete**, not idle — do NOT hook it.
- **Phase 2 — automatic (gated, after validation).** Run `rotateSessionHistory` inside `SessionManager.stop()`/`evictInactiveSessions()` (file at rest, session just deactivated), gated by threshold + cooldown, holding the rotation lock for the whole op (NOT fire-and-forget mid-swap); errors swallowed so deactivation never breaks. Never inline on the resume path. **Phase 2 gate (required, not optional):** an opt-in integration validation — rotate copied sessions, resume, send probe prompts that require pre-cut knowledge, compare to full-history behavior. Phase 2 stays off (`CACO_ROTATE_AUTO=0`) until this passes.

## Caco-side correctness

| Reader | Effect of rotation | Handling |
|---|---|---|
| `parseSessionModel` (reverse-scans for last model_change) | **Bug:** a pre-cut model_change with none after ⇒ wrong model. | Step 2 persists model to caco-meta first via `readModelFromEvents` semantics (meta-first, BYOK provider-namespace preserved); `readModelFromEvents` reads meta before parse. Abort rotation if meta write fails. |
| `readLastTurnsResult` (last 5 turns) | Tail retained | ✓ no change |
| `lastTurnsCache` (size+mtime key) | Both change | ✓ auto-invalidates |
| `searchSessionEvents` | Loses pre-cut history | Extend to also scan `events-archive.jsonl` (old search is non-critical but data is retained). |
| `readSessionEvents` / `getHistoryFromDisk` (full event read; feeds debug/history helpers) | **Becomes tail-only** after rotation | Explicit decision: these become hot-tail-only. Callers needing full history merge `events-archive.jsonl + events.jsonl` (NEVER on the hot resume path). Document in the module. |
| SDK `/rewind` (event ids) | Pre-cut rewind points lost | Accepted limitation (documented), like old search. |
| Caco `checkpoints/` | Separate from events.jsonl | ✓ unaffected |

## Crash recovery

Write a small **rotation-state marker** (`events.jsonl.rotation`: phase + candidate stats) so a crash is reconcilable by phase, not guesswork. On session-discovery/boot:
- marker absent ⇒ nothing to do.
- marker present + `.prerotate` exists ⇒ a swap died mid-flight: **verify the current `events.jsonl` via a real isolated SDK load** (structural parse is only a precheck, never authoritative); if it loads, archive/remove `.prerotate` + clear marker; if it fails or is absent, restore from `.prerotate`.
- Never delete `.prerotate` until the archive append is flushed AND the live file passed a real SDK load.

## Config (env, defaults)

`CACO_ROTATE_THRESHOLD_BYTES=67108864` (64 MB), `CACO_ROTATE_MIN_TAIL_EVENTS=4000`, `CACO_ROTATE_MIN_SAVING_BYTES=33554432` (32 MB), `CACO_ROTATE_AUTO=0` (Phase 2 off by default until validated).

## Tests

- Pure cut-point selection (compaction present / absent / too-near-head / below-threshold) — table-driven, no SDK.
- **Copy-verify-swap transactional revert:** a stub "loader" that throws ⇒ live `events.jsonl` is **byte-identical** to the original and never replaced; candidate discarded; no `.prerotate` left.
- **Concurrent-write guard:** simulate the live file's stat changing between capture and swap ⇒ rotation aborts, original intact.
- **Rotation lock:** a `resume` requested during rotation waits for the rotation promise then sees the swapped file; rotation refuses to start on an active/dispatching session.
- Model preserved: rotate a fixture whose operative model came from a pre-cut model_change ⇒ post-rotation `readModelFromEvents` correct; BYOK provider-prefixed `meta.model` preserved; abort if meta write fails.
- Archive append+fsync precedes `.prerotate` deletion; archive-append failure ⇒ swap aborted, original intact. `searchSessionEvents` finds a pruned-head match via archive.
- Crash recovery by phase marker: pre-seeded marker + `.prerotate` + bad `events.jsonl` ⇒ restored; + good `events.jsonl` ⇒ archived/cleared (authoritative real-load check).
- Real-SDK integration (manual/opt-in, not CI): rotate a copy of a mega-session, assert resume <1s and a probe reply requiring pre-cut knowledge is coherent (Phase 2 gate).

## Risks / open

- **Soft context loss:** auto-revert only catches hard SDK throws, not "model forgot older context." Mitigated by retaining from last `compaction_complete` (summary preserved) — but it is **unverified** that the SDK treats `compaction_complete.summaryContent` as authoritative replay memory, or that the summary doesn't reference deleted pre-cut tool outputs. **Must be validated** (probe-message coherence vs full-history baseline) as the Phase 2 gate before any automation, especially on the user's primary session.
- **Verify isolation:** verification uses a **separate short-lived `CopilotClient`** against a staged copy, fully stopped in `finally` — never the server's `sharedClient` (which would register the session in the live `activeSessions`/client map and could mutate the verified file). Confirmed viable by the experiment.
- **Archive durability:** `.prerotate` is deleted only after the archive append is fsynced AND the swapped live file passed a real load. Archive append failure ⇒ abort the swap (no truncation), return partial/failed status.
- Archive grows; acceptable (cold data moved off the hot path). Optional later: compress archives.
