# Prompt-cache alignment — findings

Research date: 2026-07-05. Scope: is prompt-cache alignment a real, Caco-owned lever or
a provider-only feature?

---

## 1. Provider caches? YES — observable

**PROVEN.** The Copilot SDK emits `cacheReadTokens` and `cacheWriteTokens` on every
`assistant.usage` event. Caco captures them:

| Location | Evidence |
|---|---|
| `src/dispatch-events.ts:103-106` | `extractProperty(event, 'cacheReadTokens')` / `cacheWriteTokens` → `recordUsage(...)` |
| `src/session-throughput.ts:13-17` | Comment: "cacheRead + cacheWrite ~= inputTokens (verified)" |
| `src/session-throughput.ts:234-247` | Accumulates `requestCache`, `requestCacheWrite`, `lastCacheReadTokens`, `lastCacheWriteTokens` |
| `docs/spec-deferred-savings.md:136-137` | "Tool definitions sit in the cacheable prefix, so the accrued tokens price at the model's cache rate" |

A warm turn produces `cacheReadTokens >> 0`; a tool-reveal turn produces a
`cacheWriteTokens` spike — this is the documented "cache-bust oracle"
(`spec-tool-reveal.md:93`, `:465-468`).

---

## 2. Control surface — what Caco owns vs SDK-opaque

The SDK spawns an external CLI runtime over a vscode-jsonrpc TCP/stdio connection
(`node_modules/@github/copilot-sdk/dist/client.js:1, spawn`). The runtime assembles the
final wire prompt. Caco passes:

| Field | Passed to SDK | Caco-controlled? |
|---|---|---|
| `systemMessage` | `mode:'replace'` content string | **YES** — full control |
| `tools` array | Caco tool objects from `toolFactory` | **YES** — ordering + content |
| `excludedTools` | string array of tool keys | **YES** |
| memory (on resume) | `mode:'append'` content | **YES** |
| model, cwd, mcpServers, contextTier | config fields | YES |

**SDK-owned (opaque):**

The SDK defines named system-message sections (`types.d.ts:652`):
`preamble | identity | tone | tool_efficiency | environment_context | code_change_rules |
guidelines | safety | tool_instructions | custom_instructions | runtime_instructions |
last_instructions`

Caco writes into `custom_instructions` (via `mode:'replace'`). The SDK may inject its own
content into `preamble`, `identity`, `runtime_instructions`, and other sections — those are
opaque to Caco. The SDK also owns builtin tool definitions (schema content and placement),
the history reconstruction, and the final wire serialization.

**Caco-authored prompt components (enumerated):**

1. **System prompt body** (`src/prompts.ts:buildSystemMessage`): ~1,225 tokens (post
   prompt-audit). Rebuilt per session creation, but deterministic for a given memory +
   applet set, so the prefix is stable in practice. (It was assembled once at startup and
   cached when this was written; that froze the memory block until a restart — see
   `spec-memory-frozen-in-startup-prompt`.) Content: env block (`HOME`,
   `{{SESSION_CWD}}` placeholder), work-economy rules, capabilities, applet list,
   behavior guidelines.
2. **Memory block** (`src/memory-tool.ts:formatMemoryForPrompt`): appended at session
   create/resume as `mode:'append'`. Format: `## User Memory\n- **key**: value\n…`
3. **Caco tool definitions**: schemas passed in the `tools` array via `toolFactory`.
   Includes caco namespace tools, agent tools, surface tools, etc.
4. **excludedTools**: governs which tool schemas the SDK omits from the wire prompt.

**What Caco can still stabilize (even if SDK prefix is opaque):**
- The Caco-authored sections above must be byte-identical across turns for the SDK's
  longest-prefix match to absorb them. The SDK sections that precede Caco's content are
  opaque, but if they are stable (reasonable assumption for a given model+version), then
  Caco prefix stability propagates into a stable shared prefix.

---

## 3. Volatile prefix audit

### System prompt (`src/prompts.ts`)

**No volatile content found.** Evidence:
- `grep -n "Date|timestamp|uuid|randomUUID|Math.random"` → 0 matches (`src/prompts.ts:0`)
- `process.env.HOME` / `homedir()` — static per process.
- `getHostShell()` — static config.
- `{{SESSION_CWD}}` — replaced by `resolveSystemMessage()` once per create; stable within a session; per-session cache context is separate anyway.
- Memory is appended via `formatMemoryForPrompt()` — content is the file on disk; stable unless memory changes.
- `listApplets()` — applet slug list could change if applets are installed/uninstalled between server restarts, but stable within a process lifetime (cached at startup via `buildSystemMessage()`, which is `async` and called once).

**Verdict: system prompt is STABLE.** No per-turn volatile content.

### Memory block (`src/memory-tool.ts:34`)

```ts
const keys = Object.keys(store);  // ← insertion-order, not sorted
const lines = keys.map(k => `- **${k}**: ${store[k]}`);
```

`Object.keys` returns JSON insertion order. If a key is deleted and re-added it moves to
the end — different byte sequence → cache bust on the next session create/resume that
includes a different memory state. **This is a real, small instability risk.** Severity is
low (memory rarely mutates mid-day) but trivially fixable: sort keys before formatting.

### Tool block

Caco's `toolFactory(cwd, sessionRef)` returns a flat array of tool objects. The SDK merges
these with its own builtins. The ordering of Caco-registered tools within the tools array
is determined by the order the `toolFactory` closure was assembled. This is
**construction-order stable** within a server process (no dynamic registration). However:

- MCP tools are loaded via `loadMcpServers()` (async). If async load order varies between
  `createSession` calls (unlikely given deterministic config), the order could change.
- The `excludedTools` set is assembled with `[...new Set(...)]` — spread order is
  insertion-order, which is deterministic given a fixed set of inputs (`config.excludedTools`,
  `manualDeferredKeys()`, `computeNewSessionAutoDefer()`). **STABLE.**
- **Dynamic reveals mid-session** (`rpc.options.update({excludedTools})`): confirmed
  cache-bust. The tool block changes → whole subsequent history re-billed at input rate that
  turn (`spec-tool-reveal.md:459-462`).

### Summary table

| Source | Volatile? | Severity | Fix |
|---|---|---|---|
| System prompt body | No | — | — |
| `{{SESSION_CWD}}` placeholder | Per-session only | — | — |
| Memory key ordering | Yes (key delete+re-add) | Low | Sort keys in `formatMemoryForPrompt` |
| Caco tool array order | No (construction-order stable) | — | — |
| MCP async load order | Unlikely but possible | Low | Sort MCP tool entries by name |
| SDK-owned sections | Opaque — assumed stable per model version | Unknown | Out of reach |
| Dynamic tool reveal | YES — intentional cache-bust | Accepted | Batch reveals; cold-seam gating |

---

## 4. Tool-block churn vs schema savings

### Current design is cache-aware

Auto-defer is gated on `isColdResume` (`src/session-manager.ts:2079-2087`,
`src/tool-usage-store.ts:55: COLD_RESUME_STALE_MS = 5 * 60 * 1000`):

```ts
return Date.now() - lastUsedMs > COLD_RESUME_STALE_MS;
```

Cold = >5 min idle → provider KV cache already evicted → deferral at this seam is FREE
(no warm cache to bust). Warm sessions are never auto-mutated (`spec-tool-reveal.md:17`).

### Cache-bust oracle

`cacheWriteTokens` spike on a reveal turn is explicitly documented as the cache-bust oracle
(`spec-tool-reveal.md:92-94`, `session-throughput.ts:36-38`):

> "A reveal that busts the prompt-cache shows up as a spike in lastCacheWriteTokens —
> the cache-bust oracle for spec-tool-reveal B0/C."

### Quantification (from specs)

- `spec-deferred-savings.md:136-137`: deferred tool tokens accrue at the **cache rate**
  (10× cheaper than input rate). Deferring a 200-token tool schema saves ~200 cache-rate
  tokens per turn.
- Cache-bust cost: one reveal re-bills the entire context window at the input rate for
  that turn. For a 50k-token session, a bust costs ~49,800 × (inputRate - cacheRate).
  Break-even: bust is recouped after `50k / 200 ≈ 250` turns per deferred tool — likely
  never for a single-session reveal.
- **Net: defer helps only for tools never revealed mid-session.** The current design
  correctly routes defer to cold seams (free) and accepts warm reveals as a measured cost.

### What the design does NOT do yet

There is no mechanism that defers based on whether the cache is already cold (measured by
`cacheReadTokens ≈ 0`). The comment in `tool-usage-store.ts:52` explicitly notes:

> "A later refinement can use the B0 ground-truth `cacheReadTokens≈0`"

This is an unimplemented hook: use the observed coldness signal to trigger defers only
when known-cold rather than relying solely on wall-clock staleness.

---

## 5. Verdict and ranked levers

**Prompt-cache alignment is a REAL Caco lever — (a), worth a spec.**

The skeptical hypothesis is mostly false. The SDK runtime is opaque at the wire level, but
Caco owns enough of the prefix (system prompt + tool block + memory) that stabilizing it
propagates into real cache hits. The `cacheReadTokens`/`cacheWriteTokens` telemetry is
already captured and can measure any improvement. The existing cold-seam gating for
auto-defer is cache-correct by design.

**What is out of reach:**
- SDK-owned system-message sections (`preamble`, `identity`, `runtime_instructions`): text
  and placement are opaque. Caco cannot alter them.
- `cache_control` breakpoint placement: the SDK does not expose this API to Caco callers.
- The actual wire serialization of tool definitions (schema field order within a definition
  is SDK-controlled).

**Concrete, Caco-owned changes ranked by cache-hit leverage:**

| Rank | Change | Location | Leverage | Effort |
|---|---|---|---|---|
| 1 | **Sort memory keys** in `formatMemoryForPrompt()` | `src/memory-tool.ts:34` | Prevents session-create cache bust when memory key order drifts; low token count but prefix-critical | Trivial (one `keys.sort()`) |
| 2 | **Cold-seam defer using `cacheReadTokens≈0` oracle** | `src/tool-usage-store.ts`, `src/session-manager.ts` | Anchors defer decisions to observed cache state, not just wall-clock; eliminates cases where a 4-min session was warm but auto-deferred | Low–medium |
| 3 | **Batch + gate warm reveals** to at most 1 per tool family per session | `src/session-manager.ts:enableTools` | Each warm reveal busts the full window; batching ensures ≤1 bust for a family vs N busts for N tools | Already partly designed; verify batch invariant holds |
| 4 | **Sort Caco tool array** by name in `toolFactory` output | entry point where tools array is composed | Prevents any future non-deterministic registration order from varying the tool block | Low (one `sort()`) |

**Not worth a standalone spec** — items 1 and 4 are one-line fixes. Items 2 and 3 belong
as notes in the existing `spec-tool-reveal.md` and `spec-auto-defer-latch.md` rather than
a new spec. The highest-leverage next action is: (a) land the memory sort fix, (b) add the
`cacheReadTokens≈0` coldness signal to the auto-defer decision, (c) verify the warm-reveal
batch invariant in tests.

---

## References

- `src/dispatch-events.ts:103-106` — cache token extraction
- `src/session-throughput.ts:13-247` — cache token accounting + oracle comment
- `src/prompts.ts:45-162` — system message assembly (no volatile content)
- `src/memory-tool.ts:32-36` — memory key ordering (unsorted)
- `src/session-manager.ts:715-733`, `:898-942` — createSession / resumeSession calls
- `src/tool-usage-store.ts:52-55` — `cacheReadTokens≈0` hook note + `COLD_RESUME_STALE_MS`
- `docs/spec-tool-reveal.md:17,74,92-116,459-475` — cache-bust oracle + cold-seam gating
- `docs/spec-deferred-savings.md:91-141` — deferred token accrual at cache rate
- `node_modules/@github/copilot-sdk/dist/types.d.ts:652-736` — SDK SystemMessageSection types
- `node_modules/@github/copilot-sdk/dist/client.js:1,157-176` — SDK spawns runtime + systemMessage transform
- `docs/research/harness-efficiency-landscape.md §5` — background survey
