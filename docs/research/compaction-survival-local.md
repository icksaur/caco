# Compaction survival — local audit

What Caco definitely does before/after compaction, organized by the one distinction that
matters: **content REBUILT AND RE-SENT every dispatch (survives compaction for free) vs.
content sent ONCE into the conversation history (at the mercy of the summarizer).**

Scope: facts only, with file:line evidence. No implementation plan. Where a claim could not
be established from the local tree it is marked **UNVERIFIED** rather than guessed.

Measured against: `@github/copilot-sdk` 1.0.8 (pinned), runtime `@github/copilot` 1.0.78,
platform binary `node_modules/@github/copilot-linux-x64/`.

---

## 0. The two buckets, in one table

The organizing claim. Every piece of context Caco controls is in exactly one bucket.

<table>
<tr><th>Content</th><th>Bucket</th><th>Mechanism / evidence</th></tr>

<tr><td><b>SDK <code>identity</code> section = Caco's whole system prompt</b> (Work Economy, Rendering, Tools, Caco, Applets, Sub-sessions, Behavior)</td>
<td><b>A — per request</b></td>
<td>Sent as <code>systemMessage</code> via <code>toSdkSystemMessage</code> → <code>{ mode:'customize', sections:{ identity:{action:'replace', content} } }</code> (<code>src/prompts.ts:243-250</code>). Supplied on create (<code>session-manager.ts:858</code>, <code>:1078</code>) and re-supplied on resume (<code>:1166</code>). This is the runtime <i>foundation prompt</i>, re-materialized each model call, not a conversation turn.</td></tr>

<tr><td><b><code>custom_instructions</code></b> — AGENTS.md, <code>.github/copilot-instructions.md</code>, <code>~/.copilot/copilot-instructions.md</code>, CLAUDE.md/GEMINI.md</td>
<td><b>A — per request</b></td>
<td>Deliberately NOT in <code>SDK_PROSE_SECTIONS</code>, so <code>toSdkSystemMessage</code> leaves it untouched and the runtime compiles the instruction files into it (<code>src/prompts.ts:145-152, 148</code>). Runtime assembles <code>customInstructions</code> as a distinct system-prompt section (<code>app.js</code>: <code>promptsAgentSystemPrompt([...,customInstructions,...])</code>). Re-enabled on resume via <code>enableConfigDiscovery:true</code> + <code>enableOnDemandInstructionDiscovery:true</code> re-supplied every resume (<code>session-manager.ts:1155-1160</code>).</td></tr>

<tr><td><b>Tool definitions</b> (names + schemas the model sees) and the <b>deferred/excluded set</b></td>
<td><b>A — per request</b></td>
<td>Built by <code>config.toolFactory(cwd, sessionRef)</code> and passed as <code>tools</code> + <code>excludedTools</code> on create/resume (<code>session-manager.ts:841, 1094, 1144-1146</code>). Runtime renders tool defs into the system prompt (<code>app.js</code>: <code>tools:iAt(...)</code> section). Not conversation history.</td></tr>

<tr><td><b>The deferred-tools discovery reminder text</b> (<code>&lt;system_reminder&gt;</code>-style nudge)</td>
<td><b>C — re-triggered at the compaction seam</b> (see §4)</td>
<td>Appended to the <i>user message</i> for a dispatch, NOT the system prompt: <code>modelPrompt = `${prompt}\n\n${reminder.text}`</code> (<code>src/routes/session-messages.ts:472-473</code>). So it lands in history like any user turn — but it is CHANGE-triggered and force-re-emitted after compaction. The one existing post-compaction injection template.</td></tr>

<tr><td><b>Cross-session memory</b> (<code>~/.caco/memory.json</code>, the <code>## User Memory</code> block)</td>
<td><b>A on both paths, but see §3</b></td>
<td>On <b>create</b>: baked INSIDE the identity system message via <code>formatMemoryForPrompt()</code> at <code>src/prompts.ts:108</code> (the <code>## User Memory</code> block). On <b>resume</b>: re-appended fresh as a separate <code>mode:'append'</code> system block (<code>session-manager.ts:1110, 1125-1129</code>; <code>resolveResumeSystemMessage</code> <code>:217-224</code>). Read fresh from disk each time (<code>memory-tool.ts:32-42</code>). Either way it is system-message content, not a conversation turn.</td></tr>

<tr><td><b>The user's own messages</b> (every <code>user.message</code>)</td>
<td><b>B — once into history</b>, but privileged</td>
<td>Conversation history. History <i>rotation</i> retains every <code>user.message</code> (<code>session-history-rotation.ts:88</code>), but rotation ≠ compaction. Whether the SDK's compaction summarizer preserves them verbatim is <b>UNVERIFIED</b> (native, see §5).</td></tr>

<tr><td><b>Assistant messages, reasoning, tool calls, tool outputs</b> — the actual working transcript, incl. any goal/plan the agent stated in prose</td>
<td><b>B — once into history</b></td>
<td>Pure conversation history. This is exactly the material the compaction summarizer rewrites. The enclosing goal stack lives here if it lives anywhere.</td></tr>

<tr><td><b>Session intent / todos / session-surface / environment context / custom agent defs / skills</b></td>
<td>mixed — see §6</td>
<td>Intent is server-side meta for UI, not injected into the prompt (<code>dispatch-events.ts:60-63</code>). Env/home/cwd are Bucket A (in the identity prompt, <code>prompts.ts</code>). Agent/skill definitions are Bucket A (runtime config discovery, re-supplied per resume). No todo/surface/goal-stack block is injected per turn.</td></tr>
</table>

**The load-bearing consequence.** The agent's *task* survives compaction only because the
freshest transcript tail and the compaction summary are Bucket B and are what the summarizer
keeps. The agent's *enclosing goal stack* (project → component → the specific feature) is ALSO
Bucket B and is **only** preserved if (a) the agent wrote it into the transcript as prose and
(b) the native summarizer chose to keep it. Caco injects **nothing** per-dispatch that
re-states the goal hierarchy. There is no Bucket-A or Bucket-C carrier for "the stack."
That is the gap (§7).

---

## 1. Is the system message re-assembled per dispatch, or fixed at create/resume?

**Per session lifecycle event (create / resume), not per dispatch — but it is Bucket A
because the SDK re-materializes it every model call.**

- `buildSystemMessage()` is `async` and built fresh at **create** (`session-manager.ts:1078`,
  and `:858` for the create-with-id path) and, for a forked interactive child, at **resume**
  (`:1128`). It is NOT captured once at process startup — that was the bug
  `spec-memory-frozen-in-startup-prompt.md` fixed (it removed the module-level
  `SYSTEM_MESSAGE` snapshot so a memory/applet edit reaches the next created session).
- `toSdkSystemMessage` (`prompts.ts:243-250`) translates Caco's intent into
  `{ mode:'customize', sections }`: `identity` is `{action:'replace'}` with Caco's prose,
  and every id in `SDK_PROSE_SECTIONS` is `{action:'remove'}`. `custom_instructions` is
  intentionally absent from that list so it is preserved.
- The recent `replace`→`customize` move is real and load-bearing: `mode:'replace'` discarded
  every custom-instruction source (AGENTS.md etc.); `customize` overrides only the prose
  sections and leaves `custom_instructions` intact (`prompts.ts:237-242`).

**Bottom line:** the system message content is *rebuilt* at create/resume and *re-sent as the
foundation prompt on every request* by the runtime. It is not a conversation turn, so
**compaction does not summarize it away.** (Strongly evidenced; the runtime's own
`session.compaction_start` event reports `systemTokens` and `toolDefinitionsTokens`
*separately* from `conversationTokens` — SDK types `CompactionStartData`,
`node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts:2143-2159` — i.e. the
system + tool-definition tokens are accounted apart from the conversation that compaction
acts on. That the summarizer *excludes* the system block is inferred from this split, not
read from summarizer source — see §5.)

---

## 2. The deferred-tools reminder seam (the one existing post-compaction injection)

This is the template for anything new, so it is documented exactly.

- **Where injected:** `src/routes/session-messages.ts:472-473` — into `modelPrompt` only
  (`${prompt}\n\n${reminder.text}`), with `displayPrompt` kept as the original so the marker
  never shows in the UI. It rides the *user message*, i.e. it enters conversation history.
- **When it fires:** change-triggered. `computeDeferredReminder`
  (`src/deferred-reminder-store.ts:34-42`) emits text only when the session's deferred set
  *signature* changed since last emission; otherwise `text:null`. Cost is O(defer/enable
  events), not O(turns).
- **The compaction hook:** on compaction the prior reminder scrolls out of the window, so
  `clearDeferredReminder(sessionId)` deletes the stored signature
  (`deferred-reminder-store.ts:45-47`), forcing the next dispatch to re-emit even if the set
  is unchanged. Called from **both** compaction seams: automatic
  (`dispatch-events.ts:120-125`, on `session.compaction_complete`) and manual
  (`session-manager.ts:1942`, in `compactSession`).
- **Filtered set, RPC-free:** `nextDeferredToolsReminder` (`session-manager.ts:2758-2762`) is
  synchronous, derived from the live in-memory exclusion set, adds no latency to send
  (`spec-enable-tools-discovery.md`).

**Why it matters here:** it is the sole existing mechanism where Caco detects a
post-compaction boundary and *re-injects a fixed piece of context that the boundary dropped*.
Its shape — a per-session signature/latch cleared at both compaction seams, re-emitted into
the next dispatch's model prompt — is precisely the shape a "re-state the goal stack after
compaction" carrier would take. It injects into the *user prompt* (history), not the system
prompt.

---

## 3. Memory: injected once, or every turn? And where exactly?

- **Read** fresh from `~/.caco/memory.json` on every `formatMemoryForPrompt()` call, keys
  sorted for byte-stable caching (`memory-tool.ts:32-42`).
- **Create path:** the block is *inside* `buildSystemMessage`'s returned content
  (`prompts.ts:108`), i.e. part of the `identity` system section → **Bucket A**. It is also
  persisted into that session's `events.jsonl` as a `system.message` event at create; per
  `spec-memory-frozen-in-startup-prompt.md` ("Not fixed: history already written") that
  persisted copy is permanent and a later resume replays it.
- **Resume path:** re-appended fresh as a *separate* `mode:'append'` system block
  (`resolveResumeSystemMessage`, `session-manager.ts:217-224`; call site `:1125-1129`) →
  **Bucket A** again. So on resume, memory is re-materialized regardless of what compaction
  did to history.
- **Net:** memory survives compaction. It is the *only* durable, operator-controllable,
  always-present context channel that is NOT the raw transcript. It is a global key/value
  store (`MAX_ENTRIES=50`, `memory-tool.ts:9`), not a per-session goal stack — but it is the
  one channel already in Bucket A that a resume re-asserts unconditionally.

---

## 4. Does Caco do anything BEFORE a compaction? Any pre-compaction hook?

**No.** There is no pre-compaction hook.

- `session.compaction_start` exists and carries a token breakdown
  (`session-events.d.ts:2111-2159`), and Caco lets it through the event filter
  (`event-filter.ts:23`) purely to render "Compacting conversation…" in the activity box
  (`docs/research/sdk-compaction-features.md`, `public/ts/dom-regions.ts`). It is **cosmetic**:
  no server-side handler acts on `compaction_start` in `applyDispatchEventEffects`
  (`dispatch-events.ts`), which handles only `compaction_complete` (`:120-125`).
- Consequently Caco has **no opportunity today to stage or pre-inject anything into the
  content the summarizer will see** before the summary is produced. The first moment Caco
  reacts is `compaction_complete` — after the summary already exists.

---

## 5. Can Caco steer the compaction summary itself? (auto vs manual)

<table>
<tr><th></th><th>Manual /compact</th><th>Automatic / background</th></tr>
<tr><td>Trigger</td><td><code>compactSession</code> → <code>session.rpc.history.compact({customInstructions})</code> (<code>session-manager.ts:1928-1936</code>); HTTP route <code>POST /sessions/:id/compact</code> reads <code>req.body.customInstructions</code> (<code>routes/sessions.ts:942-948</code>)</td><td>SDK threshold crossing mid-dispatch; configured by <code>infiniteSessions.backgroundCompactionThreshold</code> (<code>session-manager.ts:732, 738</code>)</td></tr>
<tr><td>Custom instructions accepted?</td><td><b>Yes.</b> Wire RPC is <code>history.compact({...customInstructions, ...trigger})</code> (runtime <code>app.js</code>). The manual <code>/compact</code> command passes <code>customInstructions:e[0]?.trim()</code> ("focus instructions").</td><td><b>No caller path supplies them.</b> The auto path is entirely inside the runtime; Caco's only knob is the threshold. The config surface (<code>InfiniteSessionConfig</code>) has only <code>backgroundCompactionThreshold</code> + <code>bufferExhaustionThreshold</code> (<code>copilot-sdk/dist/types.d.ts:1340-1346</code>) — <b>no compaction-instructions field</b>.</td></tr>
<tr><td>Throughput reset seam</td><td><code>compactSession</code> calls <code>recordCompaction</code> directly (<code>session-manager.ts:1942</code>)</td><td><code>compaction_complete</code> event → <code>recordCompaction</code> (<code>dispatch-events.ts:125</code>)</td></tr>
</table>

**Establishing it precisely:** the underlying `history.compact` RPC *does* accept
`customInstructions` (and, in 1.0.11+, `trigger`) — confirmed in the runtime bundle
(`app.js`: `case "history.compact": ... {...customInstructions...}`). But on the **automatic**
path there is no Caco (or CLI-command) caller to pass them; background compaction is
initiated by the runtime with an empty instruction (`app.js`: the compaction dispatch shows
`customInstructions:e??""` where `e` is unset on the background path). So today the auto path
**cannot be steered the same way as manual** — not because the RPC forbids it, but because
Caco never reaches that RPC for a background compaction. The only lever Caco has on the auto
path is *when* it fires (the threshold), not *what the summary keeps*.

**The summarizer prompt itself (what it is told to preserve/drop):** **UNVERIFIED — not
locally extractable.** The summary is produced in the native binary
(`node_modules/@github/copilot-linux-x64/copilot`, 177 MB SEA) via
`invokeNativeMethodJson(sessionHistoryInvokeJson, ...)` — the `history.compact` /
`summarizeForHandoff` / `clearContext` handlers are all native (`app.js`:
`session.history.summarizeForHandoff`, `history_compact` → native invoke). Grepping the
binary for the summarizer's system prompt yielded only V8/GC strings, not the instruction
text; the prompt is either in compiled code or fetched server-side. **What the summary is
told to preserve and to drop cannot be quoted from this tree.** (The parallel runtime dig may
recover it; this audit cannot.)

---

## 6. Everything else re-sent per turn (or not)

- **Session intent** (`assistant.intent` / `report_intent`): captured into server-side meta
  for the UI only (`dispatch-events.ts:57-63`), **not** injected into any prompt. Bucket:
  neither — it never reaches the model as durable context.
- **Environment context** (home, cwd): Bucket A — literal in the identity prompt (`prompts.ts`
  Environment section; cwd via `{{SESSION_CWD}}` resolved at create/resume,
  `resolveSystemMessage` `prompts.ts:133-138`).
- **Custom agent definitions / skills / MCP tools:** Bucket A — discovered by the runtime via
  `enableConfigDiscovery` / `enableOnDemandInstructionDiscovery` / `mcpServers`, all
  re-supplied on every resume (`session-manager.ts:1152-1163`).
- **Todos / session-surface / goal-stack block:** **none injected per turn.** No code path
  assembles a todo list, a surface snapshot, or a goal hierarchy into `modelPrompt` or the
  system message. (The `todos` SQLite table is workflow scaffolding, not prompt content.)
- **`<system_reminder>` blocks:** the only per-turn injected reminder is the deferred-tools
  one (§2). No other reminder block is appended to dispatches.

---

## 7. Where the stack is provably lost

1. **No Bucket-A or Bucket-C carrier for the goal hierarchy.** Caco re-asserts, every
   request: its own system prompt, custom instructions, tool defs, environment, and memory.
   None of these encodes "this session's project → component → current feature." The only
   place the enclosing goals can live is the raw transcript (Bucket B), which is exactly what
   compaction rewrites. Evidence: the full enumeration in §0/§6 — there is no goal-stack
   injection site anywhere in `prompts.ts`, `session-manager.ts` create/resume, or
   `routes/session-messages.ts`.

2. **Caco cannot influence the automatic summary.** On the background path it supplies no
   `customInstructions` and has no pre-compaction hook (§4, §5). So it cannot tell the
   summarizer "preserve the goal stack." The manual path *could* (it accepts focus
   instructions), but background compaction — the case the user hits when shrinking the
   window — cannot.

3. **The summarizer's preserve/drop policy is opaque and native (§5).** Even the ground truth
   of "what survives by default" is not readable from this tree. Caco is building on an
   unspecified summarization contract; the observed "innermost frame survives, outer frames
   gone" behavior is consistent with a summarizer that favors the recent transcript tail, but
   this is inference, not a read of the summarizer prompt.

4. **Memory is the only durable non-transcript channel, and it is global, not per-session.**
   Memory (Bucket A, re-asserted on resume, §3) is the sole existing context that reliably
   outlives compaction and is operator/agent-writable — but it is a 50-entry global KV store,
   not a per-session goal stack, and nothing writes the current goal hierarchy into it.

5. **The deferred-tools latch proves the seam exists but is single-purpose.** Caco already
   detects the post-compaction boundary and re-injects one fixed thing there (§2). Nothing
   analogous re-injects the goal stack. The mechanism to carry stack-across-compaction is
   demonstrably feasible in this codebase; it simply does not exist for goals.

---

## Appendix — key file:line index

- System prompt assembly: `src/prompts.ts:59-128` (`buildSystemMessage`), `:108`
  (memory inline), `:243-250` (`toSdkSystemMessage`), `:145-152` (`custom_instructions`
  preserved), `:133-138` (`resolveSystemMessage`).
- Create/resume system message: `src/session-manager.ts:858, 1078, 1128, 1166`;
  memory on resume `:1110, 1125-1129, 217-224`.
- Config re-supplied per resume: `src/session-manager.ts:1152-1163`.
- Compaction threshold: `src/session-manager.ts:732, 738`;
  SDK config surface `copilot-sdk/dist/types.d.ts:1340-1346`.
- Manual compaction + customInstructions: `src/session-manager.ts:1928-1943`;
  route `src/routes/sessions.ts:942-948`.
- Auto compaction reaction: `src/dispatch-events.ts:120-125`.
- Deferred-tools reminder injection: `src/routes/session-messages.ts:472-473`;
  store `src/deferred-reminder-store.ts:34-47`; selector `session-manager.ts:2758-2762`.
- History rotation cut point (retains user.messages + last compaction summary):
  `src/session-history-rotation.ts:13-16, 74-90, 106-114`.
- Throughput reset: `src/session-throughput.ts:428-434` (`recordCompaction`).
- Compaction events + token split: `session-events.d.ts:2111-2205`
  (`CompactionStartData.systemTokens`/`conversationTokens`/`toolDefinitionsTokens`).
- Event filter passthrough: `src/event-filter.ts:23-24`.
- Native summarizer (opaque): `node_modules/@github/copilot-linux-x64/copilot` invoked via
  `sessionHistoryInvokeJson` in `.../app.js`.
- Related specs: `docs/spec-memory-frozen-in-startup-prompt.md`,
  `docs/spec-workflow-savings-model.md` (compaction disjointness invariant, item 4),
  `docs/spec-history-rotation.md`, `docs/spec-enable-tools-discovery.md`,
  `docs/spec-session-context-window.md`, `docs/research/sdk-compaction-features.md`.
