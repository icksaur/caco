# Prompt Economy Research — driving maximally economical agent behavior in Caco

Goal: change Caco's `mode:'replace'` system prompt (`src/prompts.ts`,
`buildSystemMessage`, lines ~51–135) so the model spends fewer tool turns and
injects fewer fresh input tokens per turn. Those two are the cost/latency
killers and they compound: fresh input ≈ (new content per turn) × (turn count).

This doc separates **evidence-backed** techniques (cited to Anthropic/OpenAI
docs) from **folklore — measure first**. Nothing here was applied to source;
this is a change proposal.

---

## TL;DR — what's missing or weak in the current prompt

The current prompt already nails *mechanical* batching (parallel tool calls,
two-phase editing, workflow fan-out). The gaps are **behavioral/economic**, and
they're the ones that move the savings needles:

1. **No "stop early / act over search" budget.** Nothing caps exploration. This
   is the single highest-leverage missing directive (OpenAI's `context_gathering`
   pattern). Attacks: turns **and** input. **High.**
2. **No "don't re-read what's already in context" rule.** The prompt forbids
   re-`view` *after an edit*, but not re-reading files/outputs already in the
   window. Attacks: input. **High.**
3. **No explicit narration budget.** "Don't narrate between mechanical calls"
   exists, but the bigger waste — a standalone progress note as its own turn —
   isn't named as a *round trip you pay a full window replay for*. Fold-or-skip
   rule missing. Attacks: turns. **High.**
4. **No "don't echo tool output back as prose" rule.** Restating diffs/file
   contents/command output is pure fresh-input waste. Attacks: input. **Med-High.**
5. **Economy rules sit mid-prompt** (lines 81–91), buried under capability
   lists. Primacy/recency says first+last positions are read most reliably.
   **Med.**
6. **Several capability sections are verbose** and re-sent every turn
   (Applets, Extensions, Self-Modification, Schedules). Compressible. **Low-Med.**
7. **A few `MUST`/bolded imperatives** may over-trigger newer Claude/GPT-5.
   Anthropic explicitly says dial these back. **Low-Med.**

---

## 1. Behavioral economy: inducing the "quiet, dense, batch-heavy" style

The user's observation about GPT-5.5 (terse, then big tool bursts) is **trained
behavior plus prompt steering**, and it *is* reproducible across models — but
the levers differ.

| Lever | What it does | Evidence |
|---|---|---|
| Exploration budget / early-stop criteria | Caps tangential tool calls; "prefer acting over searching" | **Evidence.** OpenAI GPT-5 guide, `<context_gathering>` block with explicit "Early stop criteria" and even fixed "max 2 tool calls" budgets [1] |
| Verbosity control in natural language | Shrinks final-answer prose without hurting tool quality | **Evidence.** GPT-5 guide: trained to honor NL verbosity overrides; Cursor set global low verbosity, high only for code tools [1] |
| "Bias towards not asking the user" / persistence | Removes hand-backs that waste a round trip | **Evidence.** GPT-5 `<persistence>` block; Cursor `<context_understanding>` "Bias towards not asking the user for help" [1] |
| Parallel-tool-call directive | Pushes batch rate to ~100% | **Evidence.** Anthropic: the `<use_parallel_tool_calls>` prompt "boosts this to ~100%" [2] |
| Concise-by-default phrasing | Newer Claude already skips verbal summaries; reinforce, don't fight it | **Evidence.** Anthropic: latest models are "less verbose … may skip detailed summaries" [2] |

**Folklore flag:** "Say little until something interesting" as a *personality*
instruction is not documented to work; what reliably produces that *shape* is
(a) a low verbosity directive + (b) an exploration budget + (c) a parallel-tool
directive. Steer the mechanics, not the mood.

### Proposed additions

> **A1 — Exploration budget (NEW, place near top).** Attacks: turns+input. Impact: High. Confidence: Evidence [1].
> ```
> ## Work Economy (read first)
> Get enough context fast, then act. Parallelize discovery; stop as soon as you
> can name the exact thing to change. Don't over-search: prefer acting over
> another read. Trace only symbols you'll modify. Escalate to a wider search
> only if an edit fails validation or a real unknown appears.
> ```

> **A2 — Verbosity + persistence (NEW).** Attacks: turns+input. Impact: High. Confidence: Evidence [1][2].
> ```
> Default to terse. Keep prose between tool batches minimal; spend words only at
> phase boundaries or on the final summary. Don't hand back to the user on
> uncertainty you can resolve yourself — decide the most reasonable assumption,
> proceed, and note it at the end.
> ```

---

## 2. Reducing fresh input per turn

Fresh input = Σ(inputTokens − cacheReadTokens). Every *new* thing the model
pulls in or restates is paid once. Habits worth a directive:

| Habit | Worth a directive? | Why |
|---|---|---|
| Don't re-read a file/output already in context | **Yes** | Biggest silent leak; re-reads are 100% fresh input. Anthropic costs page: avoid redundant file reads [3][4] |
| Don't echo tool output back in prose | **Yes** | Restating a diff/command output doubles its token cost as fresh input |
| `index` + ranged `view` over full-file reads | Already present (line 78) | Keep; it's the right call [4] |
| `retrieve_output`/`grep` to narrow vs re-run | Already present (line 79) | Keep |
| Emit compact diffs, not whole files | **Yes (light)** | `edit` already does this; add a "don't paste full file back" line |
| Don't restate the plan each turn | **Yes (light)** | Plan restatement is recurring fresh input |

### Proposed addition

> **B1 — Context reuse (NEW).** Attacks: input. Impact: High. Confidence: Evidence [3][4].
> ```
> Reuse context you already have. Never re-read a file, output, or search result
> already in this conversation — refer to it. Don't echo tool output back as
> prose (no pasting diffs, file contents, or command logs you just produced);
> state only the conclusion. Don't restate the plan you already gave.
> ```

This is distinct from the existing "don't re-`view` after an edit" rule, which
only covers the post-edit case. B1 covers the much larger "it's already in the
window" case.

---

## 3. Narration economy

The worst observed waste: a progress note emitted as **its own turn** = one full
window replay for zero work. How the field handles "keep the user informed"
cheaply:

- **OpenAI GPT-5 "tool preambles":** updates are emitted **in the same message
  as the tool calls**, not as separate turns — an upfront plan + terse progress
  folded into the tool-calling turn [1].
- **Cursor (via OpenAI):** GPT-5 was *too* chatty with standalone status
  updates; they fixed it with **low global verbosity**, keeping richness only in
  code tools [1].
- **Anthropic:** latest Claude "may skip verbal summaries after tool calls,
  jumping directly to the next action" — i.e. the default is already economical;
  only add summaries if you *want* visibility [2].

**The right rule (synthesized, evidence-aligned):** never spend a turn on
narration alone. Fold any update into the message that carries the next tool
batch; if there's no next batch, it's a phase boundary and a one-line update is
fine. Quantify: a standalone note costs ≈ a full window replay (the 23-turn /
~397k-fresh-input regime makes each avoidable note worth thousands of tokens),
so narrate only when the information changes what the user would do.

### Proposed addition (replaces the weaker clause on line 86)

> **C1 — Narration budget (REPLACE existing "Do NOT narrate…" sentence).** Attacks: turns. Impact: High. Confidence: Evidence [1][2].
> ```
> Never spend a turn on narration alone — a standalone progress note costs a full
> context replay. Fold any status update into the same message as your next tool
> batch. Emit a bare update only at a true phase boundary (research → implement →
> test) and keep it to one line.
> ```

---

## 4. Prompt SIZE

The whole prompt is re-sent every turn. It's cached, so the marginal cost is
cache-read tokens, not full price — but it still (a) counts against the window
and (b) every token of fluff competes for attention with the rules that matter.
Current prompt is ~1.1k tokens; several sections over-explain.

### Compress these (before → after)

| Section | Before (gist) | After |
|---|---|---|
| **Your Capabilities** (62–68) | 6 bullets enumerating filesystem/terminal/images/media/applets/extensions | Cut to one line: `Full filesystem + terminal access; can view/embed media; render applets; load user extensions.` The model discovers tools from the tool list, not prose. |
| **Applets** (70–75) | 6 lines + examples | 2 lines: `Applets are interactive panels opened via markdown links. Call \`caco_applet_usage\` for URL patterns, \`caco_applet_howto\` to create one, \`get_applet_state\` to see what's open.` Drop the inline examples (they live in the tool). |
| **Self-Modification + Extensions + Schedules** (106–115) | 3 separate sections, each pointing at `caco_dev_docs` | Merge into one: `Caco is self-extensible (its own source, \`~/.caco/extensions/\`, schedules, MCP, hooks, skills). For any of these, call \`caco_dev_docs\` first.` |
| **Memory** (117–121) | 5 lines | 3 lines; drop the re-explanation of slug format (it's in the tool schema). |
| **Response Actions** (93–101) | ~9 lines incl. full fenced example | Keep the rule, cut the example to one inline line; full ref already pointed to `caco_dev_docs`. |

Estimated saving: ~250–350 prompt tokens/turn, cached. **Low-Med** direct
dollar impact, but it sharpens attention on the economy rules — that's the real
payoff.

**Counter-weight:** don't compress the *behavioral* rules (batching, two-phase
edit, work economy). Those few hundred tokens buy the turn savings that dwarf
the prompt size itself. Compress capability *lists*, not *behavior*.

---

## 5. Ordering & emphasis

**Evidence:** "Lost in the Middle" [5] — model performance on locating/using
information is **highest at the beginning and end** of the context and degrades
in the middle (U-shaped). Anthropic's long-context guidance echoes the
beginning matters: put the most important framing high; queries-at-end improved
quality up to 30% in their tests [2].

**Implication for Caco:** the economy rules are currently mid-prompt (lines
81–91), the worst position. Recommendation:

- **Move the core economy directives to the TOP** (a short "Work Economy" block:
  budget + batch + terse), right after the one-line environment note.
- **Reinforce at the very END** with a 2–3 line recap (the last thing the model
  reads before the conversation). Primacy + recency.
- Keep the detailed mechanics (two-phase editing, workflow fan-out) in the
  middle — they're reference material the model consults, not the behavioral
  spine.

> **E1 — End-of-prompt recap (NEW, last lines before memory).** Attacks: turns+input. Impact: Med. Confidence: Evidence [5].
> ```
> ## Remember
> Batch independent tool calls into one response. Don't re-read what's already in
> context. Don't narrate in a turn of its own. Act over searching once you know
> the change to make.
> ```

---

## 6. Anti-patterns to forbid explicitly

Naming the wasteful behavior works better than abstract exhortation (Anthropic:
"tell Claude what to do" — but a short, concrete *don't* list is effective for
agents). Proposed forbid-list (terse, model-agnostic):

> **F1 — Forbid-list (NEW, fold into Work Economy block).** Attacks: turns+input. Impact: High. Confidence: Evidence [1][2][3] + folklore for specifics.
> ```
> Don't:
> - re-read a file or output already in this conversation
> - re-view a file you just edited (edit matches text, not line numbers)
> - paste back a diff, file, or command output you just produced
> - emit a tool call to check state you can already infer
> - spend a turn on a progress note with no tool call
> - ask the user to confirm an assumption you can reasonably make
> - keep searching after you can name the exact change
> ```

Each line maps to a real observed leak. The first five are the highest-value.

---

## 7. Model-specific guidance (and how to stay model-agnostic)

Caco shares one prompt across Claude (Opus/Sonnet), GPT-5.x, and Gemini. Known
divergences:

| Behavior | Claude (latest) | GPT-5.x | Implication |
|---|---|---|---|
| `CRITICAL:`/`MUST`/bold imperatives | **Over-triggers** on Opus 4.5/4.6 — Anthropic says dial back to normal phrasing [2] | Follows precisely; contradictions waste reasoning tokens [1] | Use plain imperatives, not ALL-CAPS/`MUST`. Caco currently has several bolded "Never"/"always" — soften. |
| Contradictions in prompt | Tolerated-ish | **Actively harmful** — GPT-5 burns reasoning reconciling them [1] | Audit for conflicts (e.g. "be concise" vs "narrate each step"). |
| Default verbosity | Already terse, skips summaries [2] | Chatty with status updates unless told otherwise [1] | A terse-by-default directive helps GPT/Gemini, harmless to Claude. |
| Parallel tool calls | Excellent, steerable to ~100% [2] | Strong with explicit parallel directive [2] | One parallel directive serves all. |

**Model-agnostic phrasing rules:**
1. Plain imperative voice ("Batch independent tool calls."), not `MUST`/caps.
2. No contradictions — one instruction per behavior, stated once.
3. Give the *why* in ≤1 clause ("…a standalone note costs a full replay") —
   Anthropic shows motivation generalizes better than bare rules [2].
4. Prefer "do X" over "don't do Y" for the *primary* behavior; reserve the
   forbid-list for the specific leaks.

---

## Prioritized change set (paste-ready)

| # | Change | Where | Killer | Impact | Confidence |
|---|---|---|---|---|---|
| A1 | Exploration budget / "act over search" block | **New, top** | turns+input | High | Evidence [1] |
| C1 | Narration budget (replace line-86 clause) | line 86 | turns | High | Evidence [1][2] |
| B1 | Context-reuse rule (no re-read, no echo) | new, near batching | input | High | Evidence [3][4] |
| F1 | Concrete forbid-list | fold into top block | turns+input | High | Evidence + folklore |
| A2 | Terse-default + persistence | top block | turns+input | High | Evidence [1][2] |
| E1 | End-of-prompt recap | **last** | turns+input | Med | Evidence [5] |
| — | Move economy rules to top, recap at end | reorder | turns+input | Med | Evidence [5] |
| — | Compress capability/applet/extension/memory sections | 62–121 | input(cached) | Low-Med | Evidence [3] |
| — | Soften `MUST`/caps/bold imperatives | throughout | quality | Low-Med | Evidence [2] |

**Suggested top-of-prompt block (assembles A1+A2+F1):**
```
## Work Economy (most important)
Get enough context fast, then act. Parallelize discovery and stop as soon as you
can name the exact change — prefer acting over another read. Default to terse:
spend prose only at phase boundaries and the final summary. Resolve uncertainty
yourself and note assumptions rather than handing back.

Don't:
- re-read a file/output already in this conversation (refer to it)
- re-view a file you just edited (edit matches text, not line numbers)
- paste back a diff/file/output you just produced — state the conclusion
- emit a tool call to check state you can infer
- spend a whole turn on a progress note (fold it into your next tool batch)
- ask the user to confirm an assumption you can reasonably make
```

---

## What NOT to change (earns its keep)

- **The two-phase editing section (88–91).** Verbose, but it encodes the single
  biggest turn-saver (gather-once/edit-once) and the non-obvious "edit matches
  text not line numbers" fact that *prevents* wasteful re-reads. Keep in full.
- **The workflow fan-out nudge (48).** Long, but it's the mechanism that turns
  N reads into one round trip. Keep.
- **`index`-before-large-read (78).** Cheap, high-value; directly cuts full-file
  reads [4].
- **Memory loaded at session start.** It's already injected once and cached;
  the savings model counts on it. Don't move it into per-turn tool calls.
- **`report_intent`-with-batch pairing (85).** Prevents the intent update from
  becoming its own turn — exactly the narration-economy win. Keep.

Don't over-trim: the behavioral rules are the cheap part of the prompt and the
expensive part of the *session*. Trim lists, not behavior.

---

## Honest confidence ledger

- **Evidence-backed:** exploration budgets/early-stop [1]; folding updates into
  tool turns / tool preambles [1]; verbosity steering [1]; parallel-tool prompt
  → ~100% batch rate [2]; dial-back of `MUST`/caps for newer models [2];
  contradictions harm GPT-5 [1]; primacy/recency placement [5]; avoid redundant
  reads / code-intelligence / hook-preprocessing to cut tokens [3][4].
- **Plausible but unproven (measure first):** exact wording of the forbid-list
  lines; the claimed ~250–350-token compression payoff; whether an *end-of-prompt
  recap* beats a single top block for these specific models. A/B these against
  the savings model (virtual calls avoided, round trips saved, fresh input/turn).
- **Folklore (avoid):** "give the agent a terse personality" as a standalone
  fix; ALL-CAPS urgency as a reliability lever (counterproductive on newer
  Claude [2]).

---

## Sources

1. OpenAI — GPT-5 Prompting Guide (context_gathering, tool budgets, tool
   preambles, persistence, verbosity, Cursor tuning, instruction precision &
   contradictions): https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
2. Anthropic — Prompting best practices (parallel tool calls, verbosity/concise
   defaults, dial-back of MUST/CRITICAL, tell-what-to-do, long-context order):
   https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
3. Anthropic — Claude Code: Manage costs / reduce token usage (redundant reads,
   code intelligence, hook preprocessing, prefer CLI over MCP):
   https://code.claude.com/docs/en/costs
4. Anthropic — Claude Code best practices (context window fills fast, perf
   degrades as it fills, give a verifiable check): https://code.claude.com/docs/en/best-practices
5. Liu et al. — "Lost in the Middle: How Language Models Use Long Contexts"
   (U-shaped position bias; best at beginning/end): https://arxiv.org/abs/2307.03172
