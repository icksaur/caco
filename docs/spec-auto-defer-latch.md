# spec-auto-defer-latch

Status: draft. Branch: `feature/tool-reveal-r0-r1`.
Depends on: Phases C1/C2/C3/D1 (usage store, cold-resume + new-session auto-defer,
manual defer) — all landed. Supersedes the "live staleness verdict" behaviour of
C2/C3.

## Goals

Auto-defer must be a **latch**, not a live function of recency. Today the defer
verdict is recomputed each cold/new-session seam as `stale = now − lastUsed >
threshold` (`computeStaleDeferCandidates`), so it is **symmetric**: staleness turns
deferral ON and freshness turns it OFF — and because `lastUsed` is **system-wide**
(stamped by every `tool.execution_start`, including a per-session reveal-use), a
single session using a rare tool once marks it fresh for **every** session's next
seam, silently re-enabling it everywhere and re-inflating their per-turn tool
block.

After this change:

- **Defer is a stored system-wide verdict.** A defer-eligible tool that goes stale
  (unused > `DEFER_STALE_THRESHOLD_ACTIVE_SECONDS`) is **latched** into a persisted
  system-wide auto-defer set. Effective at every cold/new-session seam.
- **Enable is per-session and never clears the latch.** `caco_enable_tools` reveals
  a tool for one session only; it does not touch the system-wide verdict, so other
  sessions stay lean.
- **`lastUsed` still accrues but no longer re-enables.** Usage stamps continue
  (they drive the enabled→deferred SET for not-yet-latched tools, and the applet
  age badge), but a fresh stamp on an already-latched tool does **not** un-defer it
  for anyone.
- **The latch clears only by operator manual un-defer** (the mcp-servers applet
  toggle). One-way automation: nothing usage-driven un-defers a latched tool.

Synergy: this makes the footer's accrued deferral savings (spec-deferred-savings
Slice C) **stable** — they no longer evaporate the instant any session touches a
deferred tool.

## Design

**New store — `src/auto-defer-store.ts` (system-wide, persisted).** A `Set<ToolKey>`
at `~/.caco/auto-defer.json`, mirroring `manual-defer-store` mechanics (lazy load,
best-effort persist that logs-not-throws — it is fed from the create/resume path,
not a hot per-turn path, but must never throw into session setup). API:
`getAutoDeferred(): ReadonlySet<ToolKey>`, `addAutoDeferred(keys: Iterable<ToolKey>)`
(union, persist on change), `removeAutoDeferred(keys: Iterable<ToolKey>)` (persist
on change), `_resetAutoDeferForTest()`. Keyed by the model-facing `ToolKey` — the
same key space as `excludedTools` and the usage store.

**Latch scope: MCP keys only.** Only learned MCP keys enter the latch. The latch's
sole CLEAR path is the operator's per-MCP-server un-defer; a Caco pseudo-server has
no such operator control, so latching a Caco-allowlist tool would strand it deferred
forever (violating "latched ⇒ operator-clearable"). Caco-allowlist tools therefore
stay on the **live staleness recompute** — their pre-latch behaviour, recomputed each
seam and never persisted — so cross-session freshness still governs the small fixed
Caco set. (A future refinement could add a Caco un-defer affordance and fold them in.)

**SET transition (enabled → latched), at the existing cache-free seams.**
`computeStaleDeferCandidates(usedHere, logLabel)` changes from *return the freshly
computed stale set* to *grow-then-read the MCP latch, unioned with live-stale Caco*:

1. Compute the currently-stale MCP set and the currently-stale Caco set separately
   (the pure `computeColdResumeExclusions` over `allLearnedKeys()` and over
   `DEFER_ELIGIBLE_CACO_TOOLS` respectively, with `getLastUsedActiveSeconds()` and the
   shared threshold). This is still the only place `lastUsed` drives a defer decision.
2. `addAutoDeferred(staleMcp)` — union the newly-stale **MCP** keys into the latch.
3. Return `(getAutoDeferred() ∪ staleCacoLive)` **minus** `usedHere` — the WHOLE MCP
   latch (not just this seam's fresh-stale MCP set) plus the live-stale Caco tools,
   filtered by the per-session used-here protection.

So an MCP tool latches the first time it is seen stale and **stays** latched through
later freshness; step 3 seeds every historically-stale MCP tool, not only those stale
right now. Caco tools are seeded only while live-stale.

**Seed sites unchanged in shape.** `create()` (base ∪ `manualDeferredKeys()` ∪
`computeNewSessionAutoDefer()`) and cold `resume()` (base ∪ `manualDeferredKeys()`
∪ `computeColdResumeAutoDefer()`) keep their union; the auto-defer term now yields
the latch (minus used-here) instead of a live recompute. Warm/model-switch resume
still returns `[]` (the "warm never auto-mutated" invariant holds — the latch is
consulted only at the free seams).

**CLEAR transition (latched → enabled), operator-only.** `setServerDeferred(server,
false)` (the applet un-defer) already clears the manual-defer store and removes the
server's keys from every live session. It gains two steps:

1. `removeAutoDeferred(keysForServer(server))` — clear the latch for that server.
2. Stamp those keys as freshly used (`stampToolUsage` per key) so the immediate
   next seam's SET step does not re-latch a tool the operator just enabled. This is
   a *bounded* durability window (one staleness threshold, ~2 active-hours): a
   server the operator un-defers and then no session uses for that long re-latches,
   which is honest staleness behaviour (Considerations). Operator intent (explicit
   toggle) legitimately stamps recency; a passive per-session reveal does not — that
   is the distinction the Goals draw.

**Applet button reflects the system-wide verdict (manual OR any auto-latched).** The
`/servers` payload's per-server `deferred` flag becomes `isServerDeferred(server) ||
serverHasAutoLatched(server)`, where `serverHasAutoLatched(server) =
keysForServer(server).length > 0 && keysForServer(server).some(k => latch.has(k))`.
Two deliberate choices:

- **ANY latched key (not "fully latched")** — the latch is per-`ToolKey`, so a server
  can be partially latched (some tools stale, some fresh). Because operator un-defer
  is the ONLY latch-clear path, the re-enable button MUST appear whenever *any* of a
  server's keys are latched; a `fully-latched` predicate would strand a
  partially-latched server with no way to clear it. Un-defer clears **all** the
  server's keys from the latch (fully enables the server), so one click resolves any
  partial state.
- **Non-empty guard** — the `.length > 0` term prevents the vacuous-truth trap: a
  never-learned / unkeyable server (empty key list) is NOT reported deferred.

`setServerDeferred(server, true)` still writes the manual store (operator intent,
applied live to warm sessions with the cache-bust warning); it need not touch the
latch (the manual union already covers it). The button-hiding rule added earlier
stays: hide when the server is not system-wide-deferred and has no enabled tool left
to defer.

**`wouldDefer` badge becomes latch-aware.** The `/servers` per-tool `wouldDefer`
field currently means "live staleness would defer this at the next seam"
(`eligible && stale`). After the latch, an already-latched-but-freshly-used tool is
still seeded on the next create/cold-resume — so the old predicate would render
`wouldDefer:false` while the tool is in fact deferred next seam. Redefine
`wouldDefer = autoLatched(key) || (eligible && stale)` — true iff the tool is
already latched OR would newly latch this seam. The raw `stale` field is UNCHANGED
(it still reports live staleness for the age badge); only `wouldDefer` gains
latch-awareness so the applet never lies about next-seam behaviour.

**What does NOT change.** `computeColdResumeExclusions` (the pure staleness math),
the active-seconds clock, `isColdResume` gating, the per-session reveal path
(`enableTools`), and used-here protection are untouched. The usage store keeps
stamping system-wide — it is now an *input to the SET side only*, never the CLEAR
side.

## Invariants

- **MCP auto-defer is a latch, not a live function.** For MCP tools the
  enabled→deferred transition is driven by staleness (add-only); the deferred→enabled
  transition is driven ONLY by operator manual un-defer. No usage event, from any
  session, un-defers a latched MCP tool.
- **Latched ⇒ operator-clearable.** Only tools with an operator CLEAR path (MCP
  server keys, un-deferred per server) may enter the latch. Caco-allowlist tools have
  no per-server control, so they are NOT latched — they stay on the live staleness
  recompute (freshness still governs them). Nothing enters the latch that the operator
  cannot later remove.
- **Reveal is per-session and verdict-neutral.** `caco_enable_tools` mutates only
  that session's `excludedTools`; it never reads or writes the auto-defer latch or
  the manual store.
- **Warm sessions are never auto-mutated.** The latch is consulted only at the
  create and cold-resume seams (no prompt-cache prefix to bust). A warm/model-switch
  resume seeds no auto-defer.
- **One key space.** The latch, the manual store's resolved keys, `excludedTools`,
  and the usage store all key by the model-facing `ToolKey`.
- **`lastUsed` feeds SET only.** A fresh `lastUsed` can keep a not-yet-latched tool
  out of the latch; it can never remove a tool already in the latch.
- **Persistence is best-effort.** A failed latch write logs and continues; a lost
  latch entry only means a tool shows enabled until it goes stale again. Never
  throws into session create/resume.
- **The applet never lies about the next seam.** The per-server button reflects a
  single derived verdict (`manual OR any-auto-latched`, non-empty keys) and un-defer
  clears both stores; the per-tool `wouldDefer` badge is latch-aware
  (`autoLatched OR newly-stale`) so it agrees with what the next seed will actually
  defer.

## Considerations

- **Re-latch after un-defer (bounded, honest).** Un-defer stamps recency, buying one
  staleness window. A server the operator un-defers and no session uses for ~2
  active-hours re-latches — correct staleness behaviour, fully recoverable (re-reveal
  per-session, or the operator re-defers). A durable operator "pin-enabled" state is
  explicitly out of scope (a later refinement if the bounded window proves annoying).
- **Used-here protection is still per-session and in-memory.** On a cold resume in a
  fresh process the resuming session's used-here set is empty, so the latch re-defers
  a tool that session relied on; the agent reveals it in one call. Unchanged accepted
  footgun (spec-tool-reveal risk note).
- **Latch growth is monotonic.** It only grows (SET) except on operator un-defer
  (CLEAR). Bounded by the learned-key universe ∪ the Caco allowlist — small, mirrors
  the key registry; no eviction policy needed.
- **First-boot / empty latch.** A fresh install has an empty latch. Because
  `computeColdResumeExclusions` treats an absent `lastUsed` stamp as maximally stale
  (never-used = defer candidate, matching today's C2/C3), never-used eligible tools
  latch on the **first** create/cold-resume seam — there is no first-use grace. This
  is intended and unchanged from current auto-defer: a tool the model has never
  invoked is exactly a defer target. A session that needs such a tool reveals it
  per-session; if the operator wants it globally enabled, they un-defer.

## Risks and Mitigations

- **Operator un-defer appears not to stick** (re-latch after the window) → un-defer
  stamps recency for a bounded window; documented; durable pin deferred to a later
  spec.
- **Latch and manual store disagree about a server's button state** → the payload's
  `deferred` flag is a single derived predicate (`manual OR fully-auto-latched`) and
  un-defer clears BOTH, so there is one system-wide verdict the button reflects.
- **A never-learned MCP key can't latch** → same as today: only learned/keyable
  tools are candidates; unlearned tools are never deferred (nothing to key).
- **Persist failure mid-seam** → logs, continues with the in-memory latch; a lost
  write self-heals at the next stale observation.

## Acceptance

- Observable (needs signoff): with tools latched-deferred, a *different* session
  re-enabling and using them (via `caco_enable_tools`) leaves this session's
  `deferredDefsCount` and per-turn figure UNCHANGED (they no longer drop to 0). The
  mcp-servers applet shows the re-enable button for an auto-deferred server (even
  partially latched); clicking it clears the latch and the tools re-appear
  system-wide.
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `npm run check:specs` — all green.
- Oracles: see Plan (store round-trip; SET grows + persists the latch; a fresh
  `lastUsed` does not shrink the latch; reveal never touches the latch; un-defer
  clears the latch + stamps recency; seed unions the latch minus used-here; warm
  resume seeds none; partial-latch server shows the clear path; empty-key server is
  not vacuously deferred; a fresh-but-latched tool reports `wouldDefer:true`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| L1 | `auto-defer-store.ts`: persisted `Set<ToolKey>` + `getAutoDeferred`/`addAutoDeferred`/`removeAutoDeferred`/`_resetAutoDeferForTest`; lazy load, log-not-throw persist | new `src/auto-defer-store.ts` | store unit: add→read; union dedupes; remove; persist-fail logs-not-throws; reload | best-effort persistence; one key space |
| L2 | `computeStaleDeferCandidates` = compute stale (MCP + Caco separately) → `addAutoDeferred(staleMcp)` (MCP only) → return `(getAutoDeferred() ∪ staleCacoLive)` − usedHere | `src/session-manager.ts` | unit: newly-stale MCP key latched + returned; a later-fresh MCP key STAYS returned (latch, not live); a Caco tool is NOT latched (stays live); used-here filtered; log line intact | MCP latch not live function; latched ⇒ operator-clearable; lastUsed feeds SET only |
| L3 | Un-defer clears the latch + stamps recency: `setServerDeferred(server,false)` → `removeAutoDeferred(keysForServer)` + `stampToolUsage` per key | `src/session-manager.ts` | unit: un-defer removes server keys from latch and bumps their lastUsed; next `computeStaleDeferCandidates` does not re-add them | latch cleared only by operator un-defer |
| L4 | Payload `server.deferred = isServerDeferred(s) || serverHasAutoLatched(s)` (`keysForServer(s).length>0 && some(k in latch)`); per-tool `wouldDefer = autoLatched(key) || (eligible && stale)` (raw `stale` unchanged); keep the button-hide rule | `src/routes/workspace-api.ts` (payload `usageFields` + server flag), `applets/mcp-servers/script.js` | payload unit: partial-auto-latched server ⇒ `deferred:true`; empty-key server ⇒ `deferred:false` (no vacuous truth); a fresh-but-latched tool ⇒ `wouldDefer:true`, `stale:false`; visual: re-enable button shows + clears | one system-wide verdict the button reflects; badge never lies about next seam |
| L5 | Seam regression: reveal (`enableTools`) never touches the latch; warm resume seeds none | `tests/unit/*` | unit: enableTools leaves getAutoDeferred unchanged; warm resume auto-defer = [] | reveal verdict-neutral; warm never auto-mutated |

## Rationale (skippable)

The core defect is that deferral was modelled as a pure function of current
recency, making it symmetric and globally coupled through one shared `lastUsed`
map. A latch separates the two transitions: recency (an input that only ever
*ages* toward staleness) drives SET; operator intent drives CLEAR. This is strictly
less coupling — a reveal in one session can no longer act at a distance on another
session's tool block — and it is the honest model for "defer is a system-wide
preference," matching the manual-defer store it now sits beside. The bounded
re-latch window is the one concession to keeping the usage signal meaningful
without adding a third (pin-enabled) store in v1.
