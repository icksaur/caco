# Comment Best Practices for Coding Agents

How much, and what kind of, commenting is ideal when developing with AI coding
agents (Claude Code, Codex, Cursor, Copilot, Aider). Synthesized from vendor
guidance, classic software-engineering literature, and the token/context
economics specific to agents.

## TL;DR

> **Make the code say what it can through names, types, and structure. Use
> comments only for what the code *cannot* say: why it exists, what invariant
> it upholds, what constraint or trap a future editor must respect.**

The problem this document targets: agents emit copious, verbose comments that
over-explain the **what**. Long English sentences narrating well-named code add
near-zero information and impose a recurring cost every time the file is read.

The fix is not "no comments." It is **sparse, high-signal comments**.

---

## The agent-specific reason this matters

For a human, a comment is written once and skimmed occasionally. For an agent it
is **recurring context-window rent**: it is ingested on every file read, every
turn, every subagent, every review, every retry.

```
recurring cost ≈ comment_tokens × file_reads × agent_instances × (price + latency + attention penalty)
```

Consequences unique to agents:

- **Token cost.** A 200-token comment block restating a 20-line function is not
  minor clutter — it is rent paid in every session that opens the file. Prompt
  caching discounts but does not eliminate this.
- **Context rot.** Accuracy and recall degrade as input grows (observed across
  many LLMs). Low-signal prose crowds out signal.
- **Search noise.** Agents grep and semantic-search; every match enters context.
  Generic comment words ("handle", "process", "data", "manager") generate
  false-positive hits that waste the window.
- **Stale comments mislead.** Incorrect context is worse than none. Agents tend
  to treat surrounding prose as intent — they may code *to* a stale comment,
  preserve it, or propagate its wrong assumption into new tests and docs.

The asymmetry: a human writes once and reads sometimes; an agent reads thousands
of times. That turns a redundant comment in a hot file into something closer to
a log statement inside a tight loop.

---

## What the vendors actually say

| Tool | Guidance | Source |
|---|---|---|
| **OpenAI Codex** (system prompt) | "Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like 'Assigns the value to the variable' ... Usage of these comments should be rare." | `codex-rs/core/gpt-5.2-codex_prompt.md` |
| **OpenAI Codex** (newer prompt) | "Do not add inline comments within code unless explicitly requested." | `codex-rs/core/gpt_5_2_prompt.md` |
| **Anthropic Claude Code** | `CLAUDE.md` should hold only non-obvious conventions: "For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it." Excludes self-evident practices. | code.claude.com/docs/en/best-practices |
| **Cursor** | Rules should be focused; don't paste style guides — "the agent already knows common style conventions." | cursor.com/docs/rules |
| **GitHub Copilot / VS Code** | Custom instructions should be short; "Focus on information the AI can't infer from code." | code.visualstudio.com/docs/agents/best-practices |
| **Aider** | "You NEVER leave comments describing code without implementing it!" and "Do not improve, comment, fix or modify unrelated parts of the code in any way!" | `aider/coders/base_prompts.py` |

The consistent vendor default: **few comments, reserved for the non-obvious**,
configured durably via `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` /
`copilot-instructions.md`.

---

## The classic principles (pre-AI, still right)

The literature was never "never comment." It is **"comment what the code can't
say."**

- "Comments should describe things that are not obvious from the code." —
  *Ousterhout, A Philosophy of Software Design*
- "The proper use of comments is to compensate for our failure to express
  ourself in code." / "Inaccurate comments are far worse than no comments at
  all." — *Martin, Clean Code*
- "If the code is clear, and uses good type names and variable names, it should
  explain itself." / "Length is not a virtue in a name; clarity of expression
  is." — *Pike, Notes on Programming in C*
- "Don't comment bad code — rewrite it." — *Kernighan & Plauger*
- "When the code and the comments disagree, both are probably wrong." — *Norm
  Schryer (Indian Hill C style)*
- "Do not state the obvious... don't literally describe what code does." —
  *Google C++ Style Guide*

Three load-bearing ideas:

1. **A comment explaining confusing code is a smell.** First try to rename,
   extract a function, simplify control flow, or improve types so the comment
   becomes unnecessary.
2. **Names are the most reliable documentation** — tools preserve them, they
   can't silently drift the way prose can, and the compiler sees them.
3. **Comments have a maintenance cost.** They are a duplicate representation;
   document each fact once, keep it local, treat staleness as a bug.

---

## When a comment IS worth its tokens

High-signal categories — the information an agent cannot cheaply infer from
code, names, types, or tests:

1. **Rationale / intent** — *why* this approach, why not the obvious alternative.
2. **Invariants & contracts** — "`pendingWrites` is mutated only under
   `queueLock`"; "IDs are stable across restarts but not across imports."
3. **Non-local constraints** — "consumed by mobile v3 parser; do not reorder
   fields"; "must stay in sync with `billing/webhook_schema.sql`."
4. **External protocol quirks** — "Stripe retries for 72h; handler must be
   idempotent."
5. **Units, ranges, sentinels** — "timeout in ms; 0 means no timeout."
6. **Security / correctness / performance traps** — "constant-time compare to
   avoid timing leak"; "intentionally O(n²), n ≤ 12, allocation-free matters."
7. **Workarounds** — what is being worked around, why the code looks odd, when
   it can be removed, with a link.
8. **Generated-code / ownership warnings** — "generated from `schema.graphql`;
   edit the schema, not this file."
9. **Compact module/file headers** — 3–8 lines: responsibility, key invariant,
   which file to read next. These act as navigation beacons that save the agent
   several greps.
10. **Public API docstrings** — the contract: inputs, units, side effects,
    errors, idempotency, compatibility guarantees.

A useful comment is **compact, specific, accurate, rich in domain terms, and
connected to nearby code**.

---

## Bad vs Good

### Redundant "what" — delete it

```ts
// BAD
// Get the user by ID
const user = await getUserById(userId);
// Check if the user is active
if (user.isActive) {
  // Send welcome email
  await sendWelcomeEmail(user.email);
}
```
```ts
// GOOD — names already say the "what"
const user = await getUserById(userId);
if (user.isActive) {
  await sendWelcomeEmail(user.email);
}
```

### Line-by-line narration -> one "why"

```ts
// BAD: narrates arithmetic
const delays = [];
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  // Calculate the delay by multiplying the base delay
  const delay = baseDelayMs * 2 ** attempt;
  delays.push(delay); // Add the delay to the array
}
```
```ts
// GOOD: one rationale comment
// Exponential backoff so a recovering upstream isn't immediately re-flooded.
const delays = Array.from(
  { length: maxAttempts },
  (_, attempt) => baseDelayMs * 2 ** attempt,
);
```

### Comment that should be a name -> rename instead

```py
# BAD
# Returns users inactive 90+ days who should get a reminder
def get_users(users): ...
```
```py
# GOOD
def users_eligible_for_inactivity_reminder(users): ...
```

### Genuinely valuable comments

```ts
// Invariant: size <= items.length, and head always points to the oldest item.
```
```py
# Work around urllib3 folded-header bug that preserves embedded CRLF.
# Remove once https://github.com/urllib3/urllib3/issues/XXXX ships.
return value.replace("\r\n", " ").strip()
```
```ts
// ttlSeconds is seconds (API); Date.now() is ms.
return nowMs + ttlSeconds * 1000;
```

### Docstring: contract good, signature-echo bad

```py
# GOOD — documents the contract
def charge_customer(customer_id: str, amount_cents: int) -> ChargeResult:
    """Charge a customer exactly once.

    amount is in CENTS, not dollars.
    Raises PaymentDeclinedError, IdempotencyConflictError.
    """
```
```py
# BAD — restates the signature
def add(a: int, b: int) -> int:
    """Adds a and b.
    Args: a: First number. b: Second number.
    Returns: The sum of a and b."""
    return a + b
```

### TODO / dead code

```ts
// BAD:  // TODO: fix this later
// GOOD: // TODO(#1842): drop legacy parser once mobile clients are all on v3.2+.
```
Delete commented-out code — version control already remembers it.

---

## The decision test

Before writing a comment, ask:

1. Would a **better name** remove the need for it?
2. Is it explaining **why**, not **what**?
3. Does it warn about a **non-obvious** edge case, unit, or constraint?
4. Does it document a **contract the type system can't express**?
5. Would a future editor **introduce a bug** if it were absent?

If every answer is "no", **don't write it.**

And: **if a rule matters for correctness, encode it in code, types, tests,
linters, or runtime assertions** — use a comment only for the part machines
cannot verify.

---

## Drop-in ruleset for `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`

```md
## Comments
1. Do not add comments that merely restate what the code does.
2. Prefer clear names, types, and small functions over explanatory comments.
3. Comment WHY code exists, not HOW it works line by line.
4. Reserve comments for non-obvious invariants, units, ordering/constraints,
   security concerns, performance tradeoffs, and external workarounds.
5. If a comment explains what a variable/function means, rename it instead.
6. Never narrate straightforward code line by line or block by block.
7. For workarounds, link the external bug/API/issue and a removal condition.
8. Docstrings are for public APIs and must document the contract: inputs, units,
   side effects, errors, idempotency, compatibility — not the signature.
9. Skip docstrings on small private helpers when names and types suffice.
10. TODO/FIXME must include an owner or issue ID and a concrete removal/fix condition.
11. Delete commented-out code; do not leave dead code in comments.
12. Keep comments short, accurate, and adjacent to the code they describe.
13. Update or delete a comment whenever you change the related code; treat a
    stale comment as a bug.
14. When in doubt, write self-explanatory code first and add a comment only if
    important context remains hidden.
```

---

## Sources

- OpenAI Codex prompts & `AGENTS.md` — github.com/openai/codex; developers.openai.com/codex/learn/best-practices
- Claude Code — code.claude.com/docs (memory, best-practices, costs, output-styles); anthropic.com/engineering (context engineering, multi-agent)
- Cursor — cursor.com/docs/rules
- GitHub Copilot / VS Code — docs.github.com/en/copilot; code.visualstudio.com/docs/agents
- Aider — aider.chat/docs/usage/conventions.html; `aider/coders/base_prompts.py`
- Ousterhout, *A Philosophy of Software Design*; Martin, *Clean Code* (Ch. 4); Pike, *Notes on Programming in C*; Kernighan & Plauger, *Elements of Programming Style*; Google C++/Python, LLVM, Linux kernel, Indian Hill style guides
- Redundant/stale-comment research: Louis et al. (arXiv 1806.04616); Tan et al. "iComment"; Huang et al. "Are your comments outdated?"; Chroma "context rot"
