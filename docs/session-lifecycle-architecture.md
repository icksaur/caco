# Session Lifecycle — Architecture Inventory & Unification Roadmap

Status: architecture overview (document of record). Scope: everything that happens
when the active/visible session changes, client and server. Source: three deep
investigations (`files/arch-client-switch.md`, `arch-server-load.md`,
`arch-files-editor-state.md`). Goal: replace ad-hoc per-feature session-load wiring
with one ordered, testable boundary — so "load X for the session" is a one-file change.

## The core problem
There is **no single session-lifecycle abstraction**. A switch fans out through
**3 parallel client notification channels at different phases**, **4 independent
staleness guards**, **2 footer owners**, and **N independent server stores each with
its own fetch endpoint** — with **no common load bundle** and a **delete() that leaks
the whole Caco session dir**. Adding any new per-session state today means touching
many files and inheriting these gaps.

---

## A. Client switch — current shape (`public/ts/`)

12 entry points (panel click, URL nav, popstate, boot, portal msg, extension API,
`/session-fork`, new-chat send, delete-current, +pickers) funnel through
`ChatViewController.activateSession → resumeAndLoad → showChat`. That is a *partial*
orchestrator — it drives subsystems three different ways:

| Channel | Fires | Drives | Problem |
|---|---|---|---|
| Direct calls in `showChat`/`historyLoader` | scattered | transcript, scroll, footer, draft, menu, adhoc | hand-written call list; transcript-clear duplicated in **3** files |
| `app-state.onActiveSessionChange(prev,next)` | **early** (mid-resume, pre-history) | images, applet pendingState, terminal | half-initialized view; payload `(prev,next)` |
| `applet-runtime.notifySessionChange(id,info)` | **late** (in `showChat`, post-history) | applet `onSessionChange` | second channel, payload `(id,SessionInfo)` |

**Staleness:** 4 independent mechanisms must agree — `navGeneration`+`assertCurrent`,
`historyLoader.cancel()`+`lastSessionId`, websocket `historyGeneration`, and
`restoreApplet`'s ad-hoc microtask re-check.
**Footer:** 2 owner vars (`chatView.footerSessionId`, `context-footer.activeFooterSessionId`)
+ 3 per-session caches (usage, throughput, status), each restored by a separate
`showChat` call.
**Streaming teardown:** none explicit — correctness rests on scattered
`getActiveSessionId()` guards in `handleEvent`.

## B. Server load — current shape (`src/`)

`POST /resume` → `_doResume` rehydrates only the **SDK session + meta.json runtime**
(`sdkResume` = dominant `[PERF]` cost). It touches **no** Caco applet store.

Per-session disk stores under `~/.caco/sessions/<id>/`, each with its own module +
endpoint:

| Store | File | Endpoint | Read on switch |
|---|---|---|---|
| Session meta | `meta.json` | bundled in `/resume` + `/state` | yes (bundle) |
| SDK history | SDK `events.jsonl` | WS `requestHistory` | yes (separate stream) |
| File-edits cards | `files-cards.json` | `/file-edits/cards` | only if `activeApplet==='files'` |
| Surface doc | `surface.json` | `/surface` | on demand |
| Chat draft | `chat-draft.txt` | `/draft` | yes (form bind) |
| Generic blobs | `<name>.json` | `/data/:name` | on demand |
| Outputs | `outputs/…` | `/api/outputs/:id` (not session-scoped) | lazy |
| Throughput/usage | in-memory | `/throughput` | yes |

**No unified load bundle:** `/resume` folds in only `meta.json`; everything else is N
independent, mostly-sequential fetches, and `/state` redundantly re-fetches a `/resume`
subset from ≥4 modules.
**Cleanup gap (bug):** `SessionManager.delete()` removes only the SDK dir + in-memory
state — it **never `rmSync`s `~/.caco/sessions/<id>/`** (only `archive()` does). Every
Caco per-session file leaks on delete. `onSessionEnd` listeners are in-memory only; none
delete disk state. A stale comment in `chat-draft-store.ts` wrongly claims delete cleans
the dir.

---

## C. Unification roadmap (incremental — not a big-bang rewrite)

Phased so each step ships independently and de-risks the next. Features (e.g. files
editor state) plug into these seams instead of adding new ad-hoc wiring.

### R1 — Fix `delete()` cleanup (small, do first; unblocks safe new stores)
Add `rmSync(getSessionDir(id))` to `SessionManager.delete()` so the Caco dir is removed
on delete exactly as `archive()` already does; correct the stale `chat-draft-store.ts`
comment. **Any new per-session store should land on top of this**, not add another orphan.

### R2 — One client `SessionLifecycle` with two ordered phases (medium)
Promote `app-state.onActiveSessionChange` into the canonical hub, split into:
- `onSessionDeactivate(prevId)` — before teardown: clear images/transcript, cancel/redirect
  in-flight streaming, clear applet pendingState, hide terminal.
- `onSessionActivate(SessionInfo, { historyLoaded })` — once after history loads: footer
  restore, applet notify, draft bind, menu highlight, adhoc, scroll.
Subsystems **register handlers** instead of being hard-called in `showChat`; the separate
`notifySessionChange` channel is folded in and retired. Carry one monotonic generation so
`historyLoader`, `restoreApplet`, and the WS filter share a single `ctx.isCurrent()`,
collapsing the 4 staleness guards. Unify the 2 footer owners + 3 caches behind one
`ownerSessionId` + one `Map<sessionId, FooterState>`.

### R3 — Applet `activated`/`deactivated` lifecycle hooks (medium; enables MRU)
`AppletInstance` gains an activated/deactivated pair (none exists today;
`showInstance`/`_hideInstance` only flip `display`). This is the API surface MRU DOM
retention needs: on hide → flush + unsubscribe; on show → resubscribe + cheap resync.

### R4 — (optional) Server load-bundle endpoint (medium)
A single `GET /api/sessions/:id/bundle` returning meta + cards + draft + surface refs in
one round trip, replacing the N-fetch fan-out and the redundant `/state` re-fetches.
Lower priority — correctness-neutral, latency-only.

---

## How features map onto the roadmap
- **Files editor state C1** (active-tab + scroll + mode): self-contained, **needs none of
  R2–R4** — but should land on **R1** so its persisted fields are cleaned on delete.
- **MRU DOM retention C2**: **depends on R3** (the activated/deactivated hook) and benefits
  from R2 (single generation, clean deactivate). Do not attempt C2 before R3.
- Any future per-session panel: register on R2's `onSessionActivate`, store via R1-cleaned
  dir — a one-file change instead of touching `showChat` + a channel + a cache + a clear.

This document is the reference for that direction; individual steps get their own feature
specs (e.g. `files-editor-state-spec.md` for C).
