# spec-r4-resume-bundle

Status: Slice A implemented; Slice B deferred (not queue-safe); Slice C deferred
(needs an applet-seed channel). Parent: `docs/session-lifecycle-architecture.md` §R4.
Scope: server `POST /resume` response + client consumption. Correctness-neutral,
latency-only.

## Headline finding (rescopes this from the roadmap)

The roadmap (§R4) and `arch-server-load.md` claimed a session switch fans out into
**"N independent, mostly-sequential fetches"** and that a bundle would collapse
them. A fresh, line-accurate inventory shows that is **overstated**. A real switch
costs:

| # | Fetch | When | Blocking? |
|---|---|---|---|
| 1 | `POST /api/sessions/:id/resume` | `resumeAndLoad` (`chat-view-controller.ts:238`) — **already bundles meta.json** (name/kind/model/git/budget/effort/activeApplet/appletParams) | yes (the switch) |
| 2 | `GET /api/sessions/:id/throughput` | `restoreThroughput` in `showChat` (`context-footer.ts:455`) | no — fire-and-forget background |
| 3 | `GET /api/sessions/:id/draft` | lazy, only on form bind, and **only if the in-memory draft cache misses** (`chat-form-controller.ts:487-488`, `chat-draft-api.ts:49`) | no — off the transcript path |
| 4 | applet data (e.g. files `GET /file-edits/cards`, surface `GET /surface`) | **not on switch** — only when the applet mounts in `restoreApplet` | no |

History streams over the **WebSocket** separately (not HTTP). Usage is an in-memory
cache (no fetch). So the secondary HTTP cost of a switch is **1 always-background
`/throughput` + a `/draft` GET only on the first-bind cache miss**, plus — when the
session restores an applet — a `POST /applets/:slug/load` and the applet's own data
fetch. It is **not** an N-way fan-out of session stores. **R4 cannot deliver the
large win the roadmap implied, and it does not touch the dominant cost —
`sdkResume` inside `/resume` (the cold-open `[PERF]` hotspot).** This spec rescopes
R4 to what is actually true and useful.

## Goals

Make a session switch issue **no background `/throughput` round trip**: fold the
always-fetched throughput snapshot into the existing `POST /resume` response so it
renders from the resume payload. This is the only outcome R4 ships (Slice A). Draft
folding (Slice B) and applet-payload bundling (Slice C) are deferred — documented,
not built. Net: one fewer round trip per switch over the tunnel; behavior otherwise
unchanged.

## Non-goals
- No change to `sdkResume` / cold-open latency (the real cost; out of scope).
- No new `GET /bundle` endpoint. `POST /resume` already does the load + the
  required side-effects (`switchSession`); enriching its response is lower-risk
  than a parallel endpoint that would have to duplicate those side-effects.
- No change to the WS history stream or `/state` (agent-poll only; not on switch).
- No removal of the `/throughput` or `/draft` GET endpoints — other callers
  (reconnect reload, agent tools) keep using them; only the **switch path** stops
  fetching them.

## Current shape (grounded, file:line)

- `POST /resume` handler: `src/routes/sessions.ts:241`; response built at `:258-278`
  (already includes meta-derived fields). Server work: `switchSession`,
  `getSessionMeta`, `getSessionModel`, `isBusy`, `readGitBranch`.
- Throughput: server `snapshot(sessionId)` → `ThroughputSnapshot`
  (`src/session-throughput.ts:355`); route `GET /throughput`
  (`src/routes/sessions.ts:746`); client `restoreThroughput` renders cache then
  fetches (`context-footer.ts:~448-461`).
- Draft: server `getSessionDraft(sessionId)` (`src/chat-draft-store.ts:38`); route
  `GET /draft` (`src/routes/sessions.ts:775`); client `getDraft`
  (`chat-draft-api.ts:49`). Form bind reads in-memory cache first and **only
  fetches on a cache miss** (`chat-form-controller.ts:487-493`,
  `getDraftCache`/`setDraftCache` on `ChatViewController`).
- Applet data (files cards `getCardList` `src/file-edits-store.ts:58`; surface
  `getSurface` `src/surface-store.ts:114`) is fetched **inside the applet** after
  `restoreApplet` mounts it — there is no channel to hand a mounting applet a
  preloaded payload today.

## Design

### Slice A — fold throughput into `/resume` (clean, do first)
- Server: add `throughput: snapshot(sessionId)` to the `/resume` response object
  (`sessions.ts:258-278`). One extra in-process call; no new disk read beyond what
  `snapshot` already does.
- Client: `resumeAndLoad` returns `data.throughput`. Add
  `seedThroughput(sessionId, data)` to `context-footer.ts` that sets
  `throughputCache` + `renderThroughput` **without** the fetch. `showChat` calls
  `seedThroughput(sessionId, data.throughput)` instead of `restoreThroughput`.
  `restoreThroughput` stays for the reconnect path.
- Net: removes the per-switch background `/throughput` RTT. Zero behavior change
  (same rendered data, sourced from the resume payload).

### Slice B — fold draft into `/resume` (DEFERRED — not queue-safe; low value)
**Deferred. Do not implement as part of R4.** Folding the draft into `/resume`
trades a real correctness guarantee for a single non-blocking RTT, which is a bad
trade:
- The draft GET today runs inside the **per-key serialization queue**
  (`chat-draft-api.ts:25-60`) that orders it against the send-path PUT/DELETE.
  Reading `getSessionDraft()` directly in the `/resume` handler reads **outside**
  that queue, so a resume that overlaps a just-sent message can seed **stale** text
  the queue would have suppressed — the exact draft-resurrection class
  `docs/chat-draft-postmortem.md` exists to prevent
  (`chat-form-controller.ts:408-414`).
- The "seed empty so bind short-circuits" idea does not work as written:
  `setDraftCache('', …)` **deletes** the entry (`chat-view-controller.ts:101-103`),
  so bind still sees `undefined` and fetches (`chat-form-controller.ts:484-488`).
  Making it work needs a NEW explicit "hydrated" marker on the form, i.e. real
  plumbing, for a lazy off-critical-path GET.

If ever revisited, the safe shape is: the resume handler returns the draft, and the
client routes it **through the same per-key queue** (a `seedDraft` that enqueues a
no-network "set cache + mark hydrated" op ordered against PUT/DELETE), plus a
hydrated marker so an empty seed still suppresses the fetch. Not worth it now.

### Slice C — applet-payload bundling (DEFERRED; needs an applet-seed channel)
The genuinely useful tunnel win — when switching to a session whose `activeApplet`
is `files` (or `surface`), the tabs/content currently appear only after the applet
mounts and fires its own `GET /file-edits/cards` (or `/surface`), a visible
tunnel-latency gap. Bundling `cards`/`surface` into `/resume` would render them
instantly. **But** applets fetch their own data through the applet runtime, which
today exposes only URL params + state callbacks and an `AppletContent` of
html/js/css/title (`applet-runtime.ts:24-29,293-390`) — there is **no channel to
hand a mounting applet a preloaded payload**. Adding one (a `loadApplet`/`pushApplet`
seed argument, or the activated/deactivated hooks of **R3**) is its own design.
Slice C is therefore **out of scope here** and should be specced alongside that seed
channel. Documented so the value isn't lost: this is where the real files-applet
switch latency lives over a tunnel.

## Invariants

- **Latency-only, correctness-neutral** (invariant): folding throughput must not
  change what renders or any dispatch behavior; only the round trip is removed.
- **`/throughput` route stays** (invariant): the reconnect path and any tool caller
  keep using it; only the *switch* path stops calling it (`restoreThroughput` remains).
- **Resume payload is freshest** (fact): `snapshot()` is an in-memory read at switch
  time — identical to what the dropped GET returned, so no staleness.
- **Draft must stay queue-ordered** (invariant): Slice B is deferred precisely
  because a naive draft seed is not queue-safe; do not seed draft without a
  queue-routed `seedDraft` + hydrated marker.
- **Applets need a seed channel** (fact): Slice C cannot consume a preloaded payload
  until an applet-seed channel exists.
- **In-memory snapshot read** (mechanism): `session-throughput.ts` `snapshot()`.

## Risks and Mitigations (Slice A)
| Risk | Mitigation |
|---|---|
| `snapshot()` adds latency to the blocking `/resume` | `snapshot()` is an in-memory read (`session-throughput.ts:355`); negligible. Net round trips go **down** (the background `/throughput` GET is removed). Measure `/resume` timing before/after via existing `[PERF]` flight spans. |
| Throughput seed renders stale data if resume payload lags | Resume payload is computed at switch time server-side — it is the freshest snapshot; identical to what the dropped GET would have returned. |
| Other `/throughput` callers regress | `/throughput` endpoint unchanged; only the switch path stops calling it (`restoreThroughput` stays for the reconnect path). |

## Tests
- **Slice A**: `/resume` response includes `throughput`; `showChat` seeds the cache
  and renders it; no `/throughput` fetch fires on switch (assert `fetch` not called
  for that URL); reconnect path still uses `restoreThroughput`.
- Server unit: resume handler includes the new `throughput` field with the correct
  shape.
- Full gate (`npm run build`) green.

## Acceptance

- Observable: a session switch fires `POST /resume` (now carrying throughput) + the
  WS history stream, with **no** `/throughput` GET; throughput renders unchanged.
- Budgets: correctness-neutral; no extra persistence; one fewer round trip per switch.
- Gates: `npm run build` + full tests green.
- Oracles: resume response includes `throughput` (correct shape); switch path asserts
  `fetch` not called for `/throughput`; reconnect still uses `restoreThroughput`.

A session switch issues `POST /resume` (now carrying throughput) plus the WS history
stream, with **no background `/throughput` round trip**. Throughput renders from the
resume payload with no observable change. (A switch that restores an applet still
incurs the applet's own `POST /applets/:slug/load` + data fetch — that is Slice C
territory, deferred.) Draft folding (Slice B) is deferred as not queue-safe.

## Plan

Slice A shipped; B/C deferred (not implementable steps until their preconditions exist).

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Add `throughput` to the `/resume` response (server) | `src/routes/sessions.ts`, `src/session-throughput.ts` | server unit: resume payload includes `throughput` with correct shape |
| 2 | Seed throughput client-side on switch; drop the `/throughput` GET | `public/ts/*` (`seedThroughput`, `showChat`) | client test: no `/throughput` fetch on switch; reconnect still uses `restoreThroughput` |

Deferred (documented, not built): **Slice B** (draft) — needs a queue-routed
`seedDraft` + hydrated marker; **Slice C** (applet payload) — needs an applet-seed channel.
