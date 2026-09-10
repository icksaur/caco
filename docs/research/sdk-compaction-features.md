# SDK compaction surface — 1.0.8 (pinned) vs 1.0.11 (latest stable) vs 1.0.13-preview.4

Measured 2026-09-01 by unpacking each tarball and diffing `dist/generated/session-events.d.ts`
and `dist/types.d.ts`. Not from release notes — from typings.

| | pinned | latest stable | latest preview |
|---|---|---|---|
| SDK | **1.0.8** | 1.0.11 | 1.0.13-preview.4 |
| bundled runtime (`@github/copilot`) | `^1.0.73` (installed: 1.0.78) | `^1.0.79` | `^1.0.83-0` |
| session event types | 53 | 54 | 58 |

## Headline: compaction events already exist in 1.0.8, and Caco already reacts

`session.compaction_start` and `session.compaction_complete` are present in the **currently
installed** SDK. No upgrade is required to react to compaction. Caco already does, at five seams:

<table>
<tr><th>Seam</th><th>Location</th><th>Behavior</th></tr>
<tr><td>Filter passthrough</td><td><code>src/event-filter.ts:24-25</code></td><td>Both events bypass the content whitelist</td></tr>
<tr><td>Chat render</td><td><code>public/ts/dom-regions.ts:112,149,587</code></td><td>Activity box, <code>compact-text</code> styling</td></tr>
<tr><td>Throughput reset (auto)</td><td><code>src/dispatch-events.ts:125</code></td><td><code>recordCompaction(sessionId)</code> on <code>compaction_complete</code></td></tr>
<tr><td>Throughput reset (manual)</td><td><code>src/session-manager.ts:1942</code></td><td><code>compactSession</code> → <code>recordCompaction</code></td></tr>
<tr><td>History rotation</td><td><code>src/session-history-rotation.ts:30</code></td><td>Cut point = last <code>compaction_complete</code></td></tr>
</table>

Caco also writes the compaction *threshold* per session via
`infiniteSessions.backgroundCompactionThreshold` (`src/session-manager.ts:732`).

## What 1.0.11 adds that Caco cannot currently observe

**1. `CompactionTrigger` on both events** — the one materially useful addition.

```
"threshold"            background compaction crossed backgroundCompactionThreshold
"context_limit_retry"  forced by a context-limit model response (HTTP 413) before retry
"manual"               /compact command or the history.compact API
"memory_pressure"      emergency compaction from high process memory
"model_switch"         switching to a model with a smaller context window
```

Today Caco cannot tell these apart. Three consequences:

- **`docs/spec-workflow-savings-model.md` has a documented-fragile disjointness invariant**
  ("a single compaction must trigger `recordCompaction` at most once"), currently upheld by the
  *assumption* that the manual RPC never streams its event through the dispatch loop. The spec
  itself says "if a future change makes the manual RPC also stream the event through the dispatch
  loop, dedupe by compaction identity before this invariant is relied upon." `trigger` is that
  dedupe key: `applyDispatchEventEffects` can skip `trigger === 'manual'` and let
  `compactSession` own it. Converts an assumption into an observation.
- `memory_pressure` and `context_limit_retry` are *distress* signals, not routine ones. They are
  currently indistinguishable from a healthy threshold compaction in the activity box, and worth
  surfacing differently (and worth feeding the pager / idle notification path).
- `model_switch` compaction explains a context drop that otherwise looks unexplained after a
  model change.

**2. Window context on `CompactionStartData`** — adds `currentTokens` and `tokenLimit`.
1.0.8 gives only the `conversationTokens` / `systemTokens` / `toolDefinitionsTokens` split with no
denominator. With these, the compaction notice can state utilization at the moment of compaction,
and the footer can reconcile against `session.usage_info` instead of guessing.
`CompactionCompleteData` likewise gains `tokenLimit`.

**3. New event `session.context_cleared`** (`ContextClearedData { messagesCleared, initialMessage? }`)
— emitted by the `session.history.clearContext` RPC / `Session.clearContextMessages`. Absent from
1.0.8 entirely. This is a *second* context-boundary signal distinct from compaction, and every place
Caco treats compaction as a context boundary is arguably wrong to ignore it: throughput reset
(`recordCompaction`), the deferred-tools reminder in `docs/spec-enable-tools-discovery.md` (which
explicitly reminds "on the first dispatch after a resume or a compaction"), and history rotation.

**4. `SessionConfigBase` additions** (unrelated to compaction, but part of the delta):
`additionalDirectories`, `disabledMcpServers`, `managedSettings`, `githubMcpToolConfig`,
`enableFileChangeTracking`, `enableExperimentalMode`.

## What 1.0.13-preview.4 adds beyond 1.0.11

- Four `session.fusion_*` events (`route_started`, `route_failed`, `resolved`, `completed`) — an
  internal routing/fusion pipeline, no obvious Caco consumer yet.
- `behaviorModelId` on `CompactionCompleteData` (canonical model id for replaying compaction).
- A `"compaction"` turn type in the turn-type union — relevant if transcript rendering ever
  distinguishes turn kinds.
- `dist/runtimeArtifacts.*`, `includedBuiltinSkills`, `askUserVariant`, `gitHubTokenProvider`.
- `InfiniteSessionConfig` keys are **unchanged** across all three versions
  (`enabled`, `backgroundCompactionThreshold`, `bufferExhaustionThreshold`); only the doc prose
  changed. No new compaction knob.

## Upgrade risk

The pin at 1.0.8 is deliberate: it was downgraded from 1.0.9 because of package-feed latency for
users on the work box, and the work box's lockfile has previously carried a Microsoft-internal
`resolved` URL that breaks `npm install` off-network. Any bump to 1.0.11 must re-verify the
lockfile `resolved` URLs point at `registry.npmjs.org`. 1.0.11 also moves the runtime floor to
`^1.0.79` (installed runtime is 1.0.78), so the runtime upgrades with it — the instruction-loading
matrix in `instruction-loading-results.md` should be re-run after any bump.

## Bottom line

Reacting to compaction needs **no SDK upgrade**; the events are already wired. Upgrading to
1.0.11 buys `trigger` (turns a fragile invariant into an observed one and lets distress
compactions be surfaced), start-time window numbers, and `session.context_cleared` (a context
boundary Caco is currently blind to). 1.0.13-preview.4 adds nothing compaction-relevant beyond
1.0.11 and is preview-only.
