# Surviving Context Compaction: External Research

External/online research on what survives automatic context compaction across agent
harnesses, why the enclosing goal hierarchy is the thing that dies first, and the durable
techniques for keeping outer stack frames alive across a compaction boundary.

Scope note: this is an ONLINE research report. It deliberately favors general, durable
guidance over any single vendor's current summarizer prompt, which changes between versions.
Each claim is tagged:

- **[VENDOR]** — documented by the vendor (engineering blog, official docs, source).
- **[COMMUNITY]** — reported by practitioners / issue trackers / third-party writeups.
- **[ACADEMIC]** — peer-reviewed or arXiv research.
- **[INFERENCE]** — my synthesis, not directly stated by any source.

---

## 0. The shape of the problem (restating the user's observation)

The user observes a goal *stack*: project goals at the root, then the major component under
work, then the specific multi-turn feature. After auto-compaction the innermost frame
survives (the agent keeps doing the current thing) but the outer frames are dropped (it
forgets *why*). He likens it to a tail call that discards enclosing frames.

This is a real, named phenomenon, and the research below explains *why* it happens with this
exact signature — it is not bad luck or a weak summarizer. Two independent mechanisms
conspire:

1. **Compaction is recency-biased by construction.** The summarizer is fed the message
   history and told to preserve what is needed to *continue*; the concrete, recently-touched
   task dominates. High-level goals stated once, hundreds of turns ago, are exactly the
   low-recency / low-frequency tokens a lossy summarizer sheds. [INFERENCE, strongly
   supported by the Claude Code CLAUDE.md reports in §1.]
2. **Attention itself is recency- and primacy-biased** ("lost in the middle"). Even when the
   goal *is* in context, if it sits in the middle of a long window the model underweights it.
   [ACADEMIC — Liu et al. 2023, §5.]

The correct fix is therefore architectural, not prompt-tuning: the outer frames must live
somewhere **immune to compaction by construction** and be **re-anchored at a high-attention
position** (the tail or the system prompt) on every request. §2 and §7 are the payload.

---

## 1. What compaction is, and what is known to survive it, per harness

**Compaction** = take a conversation nearing the window limit, summarize it, and reinitiate a
fresh window seeded with that summary. It is universally described as **lossy**. [VENDOR —
Anthropic, https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ;
VENDOR — Amp, https://ampcode.com/news/handoff]

The critical question for the user is not "does it summarize" — they all do — but **what is
re-assembled fresh after the boundary vs. what has to survive *inside* the summary**. That is
the axis in §2. Here is the per-harness picture.

<table>
<thead>
<tr><th>Harness</th><th>Compaction mechanism</th><th>What it's told to keep</th><th>Rules/goal files re-read fresh after compaction?</th><th>Evidence</th></tr>
</thead>
<tbody>
<tr>
<td><b>Claude Code</b></td>
<td>Auto-compact near window limit; manual <code>/compact</code> (with optional focus hint).</td>
<td>Vendor: "architectural decisions, unresolved bugs, and implementation details," discards redundant tool output. Continues with the summary <b>plus the five most recently accessed files</b>.</td>
<td><b>Partial / disputed.</b> Vendor documents re-injecting the 5 most-recent files. Community reports CLAUDE.md is only *summarized*, not reliably re-read, so project rules drift or vanish after compaction. See conflict note below.</td>
<td>[VENDOR] anthropic.com/engineering/effective-context-engineering-for-ai-agents ; [COMMUNITY] github.com/anthropics/claude-code/issues/6354 ; github.com/anthropics/claude-code/issues/59309</td>
</tr>
<tr>
<td><b>Cline / Roo Code</b></td>
<td>"Auto condense" at a configurable % of window (~70–80%); model summarizes older history; checkpoints allow rewind.</td>
<td>Code changes, decisions, tool-use blocks; summarization prompt is customizable to emphasize what to keep.</td>
<td><b>Yes (rules).</b> Community/DeepWiki writeups state <code>.clinerules</code>/<code>.roo/rules</code> live in the system prompt and persist across condensation; custom summary prompts can force preservation.</td>
<td>[VENDOR-DOCS] docs.cline.bot/features/auto-compact ; docs.cline.bot/customization/cline-rules ; [COMMUNITY] deepwiki RooCodeInc/Roo-Code-Docs 4.3.4</td>
</tr>
<tr>
<td><b>Cursor</b></td>
<td>Auto-summarizes earlier turns near the limit; manual <code>/summarize</code>; "context ring" UI shows fill.</td>
<td>Most recent + relevant turns kept verbatim; rest compressed to summary.</td>
<td><b>Yes (session start / on change).</b> Vendor docs: prompt is reconstructed each message from system prompt + AGENTS.md rules + files + summary; static sections cached; AGENTS.md re-read at session start or when the file changes. Note: ".cursorrules not read in Agent mode" is a community claim.</td>
<td>[VENDOR] cursor.com/changelog/1-6 ; cursor.com/docs/agent/prompting ; [COMMUNITY] thepromptshelf.dev migration guide</td>
</tr>
<tr>
<td><b>Amp (Sourcegraph)</b></td>
<td><b>Removed compaction entirely.</b> Replaced with <b>Handoff</b>: extract what matters from the current thread into a *new* thread aimed at a stated goal; Amp drafts the new prompt + relevant file list for you to edit before sending.</td>
<td>You state the goal; Amp extracts relevant files/intent. Explicitly designed to avoid "summary stacked on summary."</td>
<td>N/A — the model is a clean thread seeded by a human-reviewable, goal-first handoff prompt, not a re-read of a rules file.</td>
<td>[VENDOR] ampcode.com/news/handoff ; ampcode.com/guides/context-management</td>
</tr>
<tr>
<td><b>OpenAI Codex CLI</b></td>
<td>Merges layered AGENTS.md (global → repo → nested) at session start under a byte cap (<code>project_doc_max_bytes</code>); closer files win.</td>
<td>AGENTS.md merge is *assembly*, not summarization — it is re-built each session, not at the summarizer's mercy.</td>
<td><b>Yes (by construction).</b> AGENTS.md is re-discovered and re-merged; it is not conversation history.</td>
<td>[VENDOR] learn.chatgpt.com/docs/agent-configuration/agents-md ; [COMMUNITY] sureprompts.com codex-cli-prompting-guide</td>
</tr>
<tr>
<td><b>OpenAI Agents SDK</b></td>
<td>No built-in LLM summarizer; community package <code>openai-agents-context-compaction</code> offers sliding-window / token-budget / boundary-aware trimming (keeps function-call pairs atomic).</td>
<td>Recent-N or token-budget of raw messages; boundary-aware, not semantic.</td>
<td>Whatever you re-inject each run — the SDK gives you the hooks; policy is yours.</td>
<td>[COMMUNITY] pypi.org/project/openai-agents-context-compaction ; github.com/damianoneill/openai-agents-context-compaction</td>
</tr>
<tr>
<td><b>Aider</b></td>
<td>Does <b>not</b> resend full raw history each call. Assembles a token-budgeted context per request: system prompt + (summarized) history + <b>repo map</b> + open-file contents.</td>
<td>Repo map = tree-sitter-parsed, PageRank-ranked symbol skeleton (default ~1/8 of window); rebuilt/cached each request.</td>
<td><b>Yes (repo map + system prompt re-assembled each request).</b> The structural map of the codebase is regenerated, not summarized.</td>
<td>[VENDOR] aider.chat/docs/repomap.html ; [COMMUNITY] deepwiki Aider-AI/aider 4.1</td>
</tr>
<tr>
<td><b>Devin</b></td>
<td>Public detail is thin; described as long-horizon with planning + memory, but the summarizer internals are not vendor-documented.</td>
<td>Unknown / not disclosed.</td>
<td>Unknown.</td>
<td>[ABSENCE] No authoritative vendor description of Devin's compaction internals was found. Treat any specific claim as unverified.</td>
</tr>
</tbody>
</table>

### The Claude Code conflict, called out explicitly

The user has been burned by confident-but-inferred claims, so this one matters. **Sources
conflict:**

- **[VENDOR]** Anthropic's engineering post states the agent continues "with this compressed
  context **plus the five most recently accessed files**." So *files* are re-injected fresh.
- **[COMMUNITY]** Multiple GitHub issues (#6354, #59309) and writeups report that **CLAUDE.md
  rules are only summarized, not re-read**, so behavioral rules degrade or disappear after
  compaction, and users must manually tell Claude to re-read CLAUDE.md.

The reconciliation [INFERENCE]: "5 most recently accessed files" is *recently touched source
files*, which is not the same as *the rules/goal file*. If CLAUDE.md wasn't among the last
files touched, it isn't in the re-injected set and only survives as summary. This is precisely
the user's "outer frame dropped" signature: the mechanism re-anchors the *innermost* working
set (recent files) but not the *outermost* directives (project rules/goals). This is the
single most decision-relevant finding for a harness author.

---

## 2. The highest-value axis: re-assembled context vs. conversation-history context

There are two fundamentally different places a piece of context can live, and they have
opposite survival properties across a compaction boundary:

- **Re-assembled context** — rebuilt into the request (usually the system prompt / prefix) on
  **every** call from an external source of truth (a file, a repo scan, a config). It is
  **immune to compaction by construction**: compaction only ever touches conversation history,
  and this content is *not* conversation history. Examples: Aider's repo map + system prompt
  [VENDOR], Codex's merged AGENTS.md [VENDOR], Cline/Roo rules in the system prompt
  [VENDOR-DOCS], Cursor's per-message prompt reconstruction [VENDOR].
- **History-resident context** — a fact that only exists because someone said it in the
  conversation. It is entirely **at the summarizer's mercy**. A high-level goal stated once in
  turn 3 and never repeated is history-resident, low-recency, low-frequency — the textbook
  casualty.

**The whole solution to the user's problem is a relocation: move the outer goal frames from
history-resident storage into re-assembled storage.** [INFERENCE, but this is the
consistent thread across every vendor that "solved" rule-persistence.]

Which harnesses deliberately exploit this:

<table>
<thead><tr><th>Harness</th><th>Deliberately re-assembles the durable layer?</th><th>What's in it</th></tr></thead>
<tbody>
<tr><td>Aider</td><td>Yes — core design</td><td>System prompt + repo map, rebuilt/cached per request</td></tr>
<tr><td>Codex CLI</td><td>Yes</td><td>Layered AGENTS.md merged each session</td></tr>
<tr><td>Cline / Roo</td><td>Yes</td><td>Rules files pinned in system prompt</td></tr>
<tr><td>Cursor</td><td>Yes</td><td>System prompt + AGENTS.md re-read, static sections cached</td></tr>
<tr><td>Claude Code</td><td>Partial</td><td>5 recent files re-injected; CLAUDE.md *not* reliably re-read → the gap</td></tr>
<tr><td>Amp</td><td>Sidesteps</td><td>Human-reviewed goal-first handoff instead of a durable layer</td></tr>
</tbody>
</table>

**Design takeaway for Caco [INFERENCE]:** whatever holds the goal stack (a plan file, a
"north star" objective, a todo list) must be **re-read from disk and re-inserted on every
request after a compaction boundary — ideally into the system prompt or the very tail** — not
left to survive as a summarized message. A harness that does this cannot exhibit the "forgot
the why" failure, because the why is never in the mortal part of the context.

---

## 3. Anthropic's context-engineering guidance (primary source)

From "Effective context engineering for AI agents"
(https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — all
**[VENDOR]**:

- **Attention budget framing.** Context is a *finite* resource with diminishing returns.
  Transformer attention is n² over tokens; models are trained more on short sequences, so
  long-range dependencies are underserved. Result is "a performance gradient rather than a
  hard cliff." They cite Chroma's context rot directly. This is Anthropic officially endorsing
  the "smaller/curated is better" intuition — see §6 for how far that actually goes.
- **Goal:** "the smallest possible set of high-signal tokens that maximize the likelihood of a
  desired outcome." System prompts at "the right altitude" — neither brittle hardcoding nor
  vague hand-waving.
- **Compaction claim (verbatim intent):** in Claude Code the model "preserves architectural
  decisions, unresolved bugs, and implementation details while discarding redundant tool
  outputs," then continues with the summary + 5 most-recent files. The safest, lightest form
  of compaction is **tool-result clearing** ("why would the agent need to see the raw result
  again?").
- **Structured note-taking / agentic memory.** The agent writes notes to a file *outside* the
  context window (a NOTES.md / to-do list) and pulls them back later. Their Claude-plays-Pokémon
  example: the agent maintains tallies and objectives across thousands of steps and, "after
  context resets, reads its own notes and continues." This is externalized memory as a
  compaction-survival mechanism — the *same idea* as relocating the goal stack to a file.
- **Sub-agent architecture as an alternative to compaction.** A lead agent holds the high-level
  plan; sub-agents do deep work in *isolated* windows and return 1k–2k-token distilled
  summaries. "The detailed search context remains isolated within sub-agents, while the lead
  agent focuses on synthesizing." They explicitly frame the choice: compaction for
  back-and-forth flow, note-taking for milestone-based iterative dev, multi-agent for
  parallelizable work with clear separation of concerns.

Anthropic's own framing thus supports the user's plan: with smaller windows you compact more,
so you should lean harder on **note-taking (externalized memory)** and **sub-agents (context
isolation)** rather than trying to make the summarizer perfect.

---

## 4. The goal-hierarchy / long-horizon problem specifically

### Academic

- **Liu et al. 2023, "Lost in the Middle."** [ACADEMIC —
  https://arxiv.org/abs/2307.03172] U-shaped positional performance: models use info at the
  **beginning (primacy)** and **end (recency)** far better than the middle; the effect holds
  even for long-context models. Direct implication: a goal buried mid-window is
  underweighted even when present. Corollary — the *fix* is positional: put the goal at an end.
- **"Evaluating Goal Drift in Language Model Agents."** [ACADEMIC —
  https://arxiv.org/abs/2505.02709] Measures agents losing their original objective over long
  horizons and under perturbation. Establishes goal drift as a measurable, named failure mode,
  not folklore. (A related community replication reports ~12–13% drift under perturbation such
  as new information; treat the exact number as [COMMUNITY] — github.com/livleavitt/goal-drift-study.)
- **"Inherited Goal Drift: Contextual Pressure Can Undermine Agentic Goals."** [ACADEMIC —
  arXiv 2603.03258 as cited] Finds that strong spec/hierarchy-following does **not** reliably
  protect against drift under changing context — i.e., "just write a good spec" is necessary
  but not sufficient; the spec must also be kept *salient*.
- **MemGPT / Letta.** [ACADEMIC + VENDOR — arXiv 2310.08560 ; docs.letta.com] An OS-inspired
  memory hierarchy: **core memory** (labeled, char-limited blocks always in context, e.g.
  `persona`, `human`), **recall memory** (searchable recent history), **archival memory**
  (vector store). The agent **self-edits** core memory via tools
  (`core_memory_append`/`core_memory_replace`) and pages tiers in/out under memory pressure.
  This is *directly analogous to the user's stack*: core memory is a small, always-present,
  self-maintained region that survives when the raw history is evicted. A "goal stack" block in
  core memory is exactly the MemGPT pattern.

### Practitioner

- **Manus — recitation via `todo.md`.** [COMMUNITY — manus.im lessons; multiple mirrors]
  Every iteration, the agent rewrites its objectives/checklist and **appends it to the tail of
  the context**, deliberately exploiting recency bias so the current plan is always in the
  highest-attention position. Manus frames this explicitly as an anti-drift, anti-lost-in-the-
  middle mechanism, and also advocates "file system as context" (page in, don't compress) and
  "keep error traces" (don't summarize away failures).
- **"Goal recitation."** [COMMUNITY — agentpatterns.ai/context-engineering/goal-recitation]
  Generalizes Manus: periodically re-state the high-level goal at the context tail to keep it
  salient; leverages recency to counter drift.
- **Amp Handoff.** [VENDOR — ampcode.com/news/handoff] The anti-drift move is *architectural*:
  don't let a thread meander and stack summaries; start a fresh, goal-first thread. The goal is
  the literal first thing in the new thread — maximum primacy.

---

## 5. Is "smaller windows are more accurate" actually supported?

### Evidence FOR

- **Chroma "Context Rot" (2025).** [COMMUNITY/primary — https://research.trychroma.com/context-rot]
  18 frontier models; task difficulty held constant while context length varies. All degrade as
  input grows, often well before the advertised max. Degradation covers retrieval, reasoning,
  and QA — not just needle-in-a-haystack. Distractors and low signal-to-noise accelerate it.
  Practitioner summaries quote an "effective" usable fraction well below the spec window; treat
  the specific "25–30%" figure as [COMMUNITY interpretation], not a Chroma headline constant.
- **Anthropic** officially endorses the mechanism (attention budget, n², context rot citation)
  [VENDOR, §3].
- **Liu et al.** — more middle-content = more underweighted content [ACADEMIC, §4].

So the *directional* claim — "a smaller, higher-signal window is more reliable per token than a
bloated one" — is **well supported**. This is the strong, durable part.

### Evidence AGAINST / the costs (the honest other half)

- **Smaller window ⇒ compact more often ⇒ more lossy summarization events.** Each compaction is
  a lossy re-encoding; stacking summaries compounds loss. Amp abandoned compaction *specifically
  because* "summary on summary" degraded quality. [VENDOR — ampcode.com/news/handoff]
- **Each compaction costs a summarizer LLM call** — latency and tokens. More frequent boundaries
  = more of these. [INFERENCE, obvious from mechanism.]
- **Compaction is where the goal-stack loss actually happens.** So making windows smaller
  *without* fixing where the goal lives will make the user's exact complaint *worse*, more
  often. [INFERENCE — this is the crux for his experiment.]
- Summarization-quality research shows naive one-shot/map-reduce summarization can drop quality
  sharply; the summarization *method* matters as much as frequency. [ACADEMIC — arXiv 2310.10570.]

### Honest verdict

The premise is **half-right and task-dependent**, with an important asymmetry:

- The claim "a curated small window beats a bloated one at equal task" is solid.
- The claim "therefore compact aggressively and often" is **not** automatically safe, because
  the cost of smallness is paid at the compaction boundary — the precise place the outer goal
  frames die.
- There is **no single vendor-blessed sweet-spot number** — the "8k–32k" figures in
  practitioner posts are [COMMUNITY] and task-dependent. What *is* durable: keep the *working*
  window lean, but make the smallness safe by ensuring the durable layer (goals/rules/plan) is
  **re-assembled, not summarized**. Then more-frequent compaction stops being lossy *where it
  matters*. The winning configuration is "small working window + immortal goal layer," not
  "small window and hope the summarizer keeps the goal."

---

## 6. Concrete, transferable techniques to keep outer frames alive

<table>
<thead><tr><th>Technique</th><th>Who does it</th><th>Claimed to work?</th><th>Cost</th><th>Evidence</th></tr></thead>
<tbody>
<tr>
<td><b>Plan/spec file re-read after every boundary</b> and re-inserted into the prefix</td>
<td>Aider (repo map), Codex (AGENTS.md), Cline/Roo (rules) — all re-assemble a durable layer</td>
<td>Yes — this is the mechanism behind every harness that "solved" rule persistence</td>
<td>Tokens on every request for the file; must keep the file small/high-signal</td>
<td>[VENDOR] aider repomap; codex agents-md; cline rules</td>
</tr>
<tr>
<td><b>Persistent objective restated in the system prompt</b> ("north star")</td>
<td>Cursor/Cline pin rules in system prompt; general context-engineering guidance</td>
<td>Yes — system prompt is prefix, immune to compaction, high primacy</td>
<td>Static; needs updating when the objective legitimately changes</td>
<td>[VENDOR] cursor prompting docs; [VENDOR] Anthropic system-prompt "altitude"</td>
</tr>
<tr>
<td><b>Todo list / checklist as durable state, rewritten to the tail each turn</b> (recitation)</td>
<td>Manus (todo.md), Claude Code (to-do lists), Anthropic note-taking guidance</td>
<td>Yes — explicitly claimed to counter drift + lost-in-the-middle via recency</td>
<td>Rewrite cost each turn; risk of stale checklist if not disciplined</td>
<td>[COMMUNITY] Manus; [VENDOR] Anthropic (note-taking, Pokémon)</td>
</tr>
<tr>
<td><b>Handoff document</b> — extract goal + relevant files into a fresh, goal-first thread</td>
<td>Amp (Handoff)</td>
<td>Yes (vendor); avoids summary-stacking; goal gets max primacy</td>
<td>Human-in-the-loop review step; discontinuity between threads</td>
<td>[VENDOR] ampcode.com/news/handoff</td>
</tr>
<tr>
<td><b>Agent-authored memory file</b> (NOTES.md) written outside context, paged back in</td>
<td>Anthropic note-taking; Manus "file system as context"; MemGPT archival</td>
<td>Yes — vendor-demonstrated across multi-hour horizons</td>
<td>Retrieval discipline; agent must actually re-read it</td>
<td>[VENDOR] Anthropic; [ACADEMIC] MemGPT 2310.08560</td>
</tr>
<tr>
<td><b>Self-editing core-memory block</b> holding the goal stack, always in context</td>
<td>MemGPT / Letta core memory</td>
<td>Yes — this is the closest formal analog to the user's stack</td>
<td>Char-limited; agent must maintain it; always-present token cost</td>
<td>[ACADEMIC/VENDOR] docs.letta.com memory-blocks</td>
</tr>
<tr>
<td><b>Sub-agent context isolation</b> — outer goal stays with the lead, deep work in clean child windows</td>
<td>Anthropic multi-agent; Amp subagents</td>
<td>Yes — Anthropic reports substantial gains vs single-agent on research</td>
<td>Orchestration complexity; hand-off summaries can lose detail</td>
<td>[VENDOR] Anthropic multi-agent-research-system; effective-context post</td>
</tr>
<tr>
<td><b>Tool-result clearing</b> (drop raw tool output, keep the conclusion)</td>
<td>Claude Code / Claude Developer Platform</td>
<td>Yes — "safest lightest touch" compaction; frees budget without touching goals</td>
<td>Must retain the *conclusion*, not just delete</td>
<td>[VENDOR] Anthropic context-management</td>
</tr>
<tr>
<td><b>Write rules for the summarizer</b> (bullets, CRITICAL tags, concrete file-scoped rules)</td>
<td>Claude Code community workarounds</td>
<td>Partial — a mitigation, not a fix; still history-resident</td>
<td>Cheap; unreliable — the point is you shouldn't *need* it</td>
<td>[COMMUNITY] dev.to CLAUDE.md compaction; issue #6354</td>
</tr>
</tbody>
</table>

The pattern across the whole table: the techniques that are **claimed to reliably work** all
move the goal into a **re-assembled or always-present region** (system prompt, re-read file,
tail-appended checklist, core-memory block, fresh handoff prompt). The techniques that are only
**partial mitigations** all leave the goal **history-resident** and try to make the summarizer
treat it kindly. That distinction — not the specific vendor or the specific file name — is the
durable lesson.

---

## 7. Documented absences (real findings)

- **Devin's compaction internals** are not vendor-documented in any source found. Any specific
  claim about what Devin's summarizer keeps should be treated as unverified.
- **No vendor publishes the actual text of its compaction/summarizer prompt** (Claude Code's is
  the most-described but still paraphrased). Reverse-engineered versions circulate in the
  community but are version-specific and not authoritative — consistent with the user's
  instinct that the exact prompt is an implementation detail not worth anchoring on.
- **No authoritative "effective context = X% of window" constant.** The 25–30% and 8k–32k
  figures are practitioner interpretations of Chroma / benchmarks, not vendor guarantees, and
  are task-dependent.

---

## 8. Durable guidance (still true after vendors change their summarizers)

These principles do not depend on any current summarizer prompt.

1. **Two storage classes, not one.** Every fact your agent needs lives in either
   *re-assembled* context (rebuilt each request from an external source — immune to compaction)
   or *history-resident* context (at the summarizer's mercy). Decide, per fact, which it is.
   This is the master principle; everything else follows.

2. **The goal stack belongs in the immortal class.** Project goal → component → current feature
   should be held in a file (or a self-edited memory block) that is **re-read and re-inserted
   on every request**, especially immediately after a compaction boundary. If the "why" is
   never in the mortal part of context, "forgot the why" becomes structurally impossible. This
   is the direct fix for the user's tail-call analogy.

3. **Position is a lever: primacy and recency win.** Put the durable goal in the **system
   prompt (primacy)** and/or **append the live plan to the tail (recency)**. Never rely on a
   goal sitting in the middle of a long window — "lost in the middle" is a stable architectural
   property, not a passing bug.

4. **Compaction should touch the recoverable, never the irreplaceable.** Tool outputs, raw
   file dumps, and verbose logs are recoverable (re-fetch/re-run) — compact those aggressively.
   Decisions, unresolved bugs, and the goal hierarchy are irreplaceable — those must not be
   entrusted to a lossy summarizer at all; relocate them (principle 2).

5. **Smaller windows are safe only if the durable layer is immortal.** The accuracy win from a
   lean window is real, but its cost is paid at the compaction boundary — exactly where goals
   die. More-frequent compaction *amplifies* goal loss unless the goal already lives in the
   re-assembled layer. "Small working window + immortal goal layer" is the configuration that
   actually banks the accuracy win.

6. **Recite the goal; don't just store it.** Even immortal storage underperforms if the model
   isn't re-anchored to it. Periodically restate the objective at a high-attention position
   (the recitation / todo.md pattern). Storage guarantees presence; recitation guarantees
   attention.

7. **Prefer isolation over compression for parallelizable work.** When a sub-task needs a lot
   of context, give it a clean child window and return a distilled result, rather than letting
   its detail pollute (and later be compacted out of) the parent. The outer goal stays intact
   with the lead agent by never being at risk.

8. **Don't tune the summarizer prompt as your primary strategy.** It is version-specific,
   vendor-controlled, and only a mitigation. Architecture (where the goal lives, what position
   it occupies) is what you own and what survives vendor changes.

---

### Source index (primary / most load-bearing)

- Anthropic, "Effective context engineering for AI agents" [VENDOR] —
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, context management / tool-result clearing [VENDOR] —
  https://www.anthropic.com/news/context-management
- Amp, "Handoff (No More Compaction)" [VENDOR] — https://ampcode.com/news/handoff
- Aider repo map [VENDOR] — https://aider.chat/docs/repomap.html
- Cline auto-compact / rules [VENDOR-DOCS] — https://docs.cline.bot/features/auto-compact ,
  https://docs.cline.bot/customization/cline-rules
- Cursor slash commands/summarization + prompting [VENDOR] — https://cursor.com/changelog/1-6 ,
  https://cursor.com/docs/agent/prompting
- Codex AGENTS.md [VENDOR] — https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Chroma, "Context Rot" [primary] — https://research.trychroma.com/context-rot
- Liu et al., "Lost in the Middle" [ACADEMIC] — https://arxiv.org/abs/2307.03172
- "Evaluating Goal Drift in Language Model Agents" [ACADEMIC] — https://arxiv.org/abs/2505.02709
- MemGPT [ACADEMIC] — https://arxiv.org/abs/2310.08560 ; Letta docs — https://docs.letta.com
- Claude Code CLAUDE.md-after-compaction reports [COMMUNITY] —
  https://github.com/anthropics/claude-code/issues/6354 ,
  https://github.com/anthropics/claude-code/issues/59309
- Manus context-engineering lessons / recitation [COMMUNITY] — manus.im blog and mirrors ;
  https://agentpatterns.ai/context-engineering/goal-recitation
