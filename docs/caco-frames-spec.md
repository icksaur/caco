# Spec: `caco.frames` — code navigation via the index facade

## Goal

Collapse the `index → view → view → view …` tool-call chain into **one workflow call**
that returns the code for a symbol's **"stack frames"**: its definition(s), the sites
that call it (incoming), and what it calls (outgoing) — as compact snippets, not whole
files. A speed *and* cost win with no tradeoff (fewer round trips; raw search output
stays out of context; only chosen snippets are emitted).

This is the pragmatic unification of B2 (graph) and `index_multiread`: navigation
routed to battle-tested mechanisms, not bespoke semantic analysis.

## Hard requirement: portability (Windows, no `rg`/`bash`/`git`)

`caco.frames` MUST be built only on the JS/WASM facade primitives and work on a vanilla
Windows Node install:

- **Allowed:** `caco.grep` (rg with automatic pure-JS fallback in `grepCore` on ENOENT),
  `caco.glob` (Node `fs/promises.glob`), `caco.read` (Node `readFile`), `caco.index`
  (`web-tree-sitter`, WASM — no native binary).
- **Forbidden:** `caco.rg` (raw `rg`, fails without it), `caco.sh` with bash/`git grep`/
  `find`/pipes (on Windows `caco.sh` runs cmd/PowerShell — bash syntax won't execute).
- **`rg` is a speed bonus, not a correctness dependency.** With rg, `grepCore` is fast and
  prunes via gitignore; without it, `jsGrep` works but is slower and walks everything — so
  `caco.frames` MUST scope every search to source globs (never the whole tree) to keep the
  fallback usable on large repos.

## What "stack frames" means here

Given a symbol (and optionally a file to disambiguate):

| Frame kind | How | Tier |
|---|---|---|
| **definition** | precise declaration/body location + code | tree-sitter (`caco.index`) where a grammar exists; regex fallback otherwise |
| **incoming** (callers) | sites that reference the symbol | `caco.grep` word-boundary, ranked to drop imports/comments |
| **outgoing** (callees) | symbols referenced inside the definition's range | scan the def range, resolve each via the definition tier |

Output is a compact bundle of `{ kind, file, line, code }` snippets the model can read in
one shot, with a `truncated` flag and caps on count/snippet size.

## Cross-stack behavior (verified on real code)

Proven live: `recordToolCall` in this repo (TS), and `HullRenderer` + a `Bone` struct
spanning C++ headers and a GLSL shader in the hull graphics repo.

| Stack | Definition tier | References | Notes |
|---|---|---|---|
| TS / JS / TSX | tree-sitter ✅ | `caco.grep` ✅ | clean |
| C++ | tree-sitter ✅ | `caco.grep` ✅ | **return both `.h` declaration and `.cpp` definition** (the split is a feature, not a bug) |
| C# | tree-sitter ✅ | `caco.grep` ✅ | namespaces/partials handled textually |
| Shaders (GLSL/`.comp`/`.frag`) | **regex fallback** (no grammar) | `caco.grep` ✅ | less precise; still finds `struct`/`void main`/fn defs |

**Why textual references are the right backbone:** they are language-agnostic and the
only mechanism that spans the C++↔shader boundary (no semantic tool parses both). For
"gather the candidate frames," textual breadth beats semantic precision.

## Proposals

### Proposal A — `caco.frames(symbol, opts?)` facade method (RECOMMENDED)

No new top-level tool (consistent with the diet). Signature:

```ts
caco.frames(symbol: string, opts?: {
  glob?: string;            // source scope; default per detected languages, never whole tree
  file?: string;            // disambiguate when the symbol is defined in many places
  include?: ('definition' | 'incoming' | 'outgoing')[]; // default all
  context?: number;         // lines of code around each site (default ~6)
  maxFrames?: number;       // cap total snippets (default ~20)
}): Promise<{
  symbol: string;
  definitions: Frame[];     // decl + impl (C++ both)
  incoming: Frame[];        // callers, ranked
  outgoing: Frame[];        // callees within the definition
  truncated: boolean;
  notes?: string[];         // e.g. "shader def via regex fallback", "rg absent: JS grep"
}>
// Frame = { kind, file, line, code }
```

Composed from `caco.index` + `caco.grep` + `caco.read` + ranking. The model calls one
method inside a workflow and `emit`s the slice it wants.

### Proposal B — documented workflow pattern only (no helper)

Just document "how to gather frames in a workflow" with a snippet. Rejected as primary:
the ranking + C++ pairing + shader fallback + portability scoping is exactly the fiddly
logic that should be written and tested once, not re-derived (buggily) per call — the
same lesson as C1/A3.

### Semantic v2 (LSP: clangd / tsserver / Roslyn) — OUT of scope

True semantic precision (overload/template resolution, exact call hierarchy) needs a
language server: clangd (needs `compile_commands.json`), tsserver, Roslyn/OmniSharp
(needs the .NET SDK + project load). Each is a different **stateful** integration, none
covers shaders, and it violates the "simple, on the shoulders of giants" intent. Defer;
if pursued, it is a per-stack opt-in layered behind the same `caco.frames` shape, not v1.

## Recommended design: Proposal A, textual+tree-sitter, portable

- New module `src/index/frames.ts`: `buildFrames(cwd, symbol, opts)` — pure, tested,
  uses only `indexCore` + `grepCore` + `readFileRangeCore` (the same cores the facade
  wraps), so it inherits the rg→JS fallback and path scoping for free.
- **Definition tier:** call `indexCore` on candidate files (found by a scoped
  `caco.grep` for the symbol) and match the declaration whose name equals the symbol;
  for C++, collect both the header declaration and the `Type::method` body. For
  shader/unknown files, fall back to a small per-language regex set
  (`struct X`, `<type> X(`, `void main`).
- **Incoming:** `grepCore('\\bsymbol\\b', { glob })`, then rank: drop pure import/`#include`
  lines, comment-only lines, and the definition site itself; prefer call-shaped sites
  (`symbol(`). Cap to `maxFrames`.
- **Outgoing:** slice the definition range, find identifier-call tokens, resolve each via
  the definition tier (best-effort; record unresolved in `notes`).
- **Snippets:** `readFileRangeCore` a `context`-line window per site.
- **Facade wiring** (`src/workflow/facade.ts`): add `frames` to `Facade`, `createFacade`,
  `wrapFacadeForAccounting`, `FACADE_API_SUMMARY`, `FACADE_DTS`. One prompt line.

## Considerations

- **Textual imprecision is acceptable and sometimes desirable.** rg can't separate 5
  overloaded `render()`s — it returns all 5. For "show me the frames," that breadth is
  usually what you want; the model filters. Document it; do not pretend it is semantic.
- **Portability scoping is load-bearing.** The JS grep fallback has no gitignore pruning,
  so an unscoped search on a big repo walks `node_modules`/build dirs. `caco.frames` must
  default `glob` to source dirs by detected language and exclude common build output;
  never search the whole tree.
- **C++ `.h`/`.cpp` split is a first-class output**, not noise: definitions returns the
  declaration AND the implementation.
- **Cost stays in the workflow.** Indexing candidate files + grepping happens in the
  child process; only the compact frame bundle emits. The byte oracle can't measure
  facade methods; value is the use-case (chain collapse), shown by a before/after turn
  count on a real navigation task.
- **Symbol ambiguity.** A common name (`update`, `render`) yields many definitions; `file`
  narrows, and `definitions` is capped with `truncated`. Return the candidates rather than
  guessing one.
- **No mid-session anything.** Pure facade addition; no registration/lifecycle concerns.
- **Reuses the B2 resolver if/when built** (import resolution for outgoing cross-file
  callees), so the two efforts share code.

## Acceptance

- **Definition-tier oracle (independent):** unit tests on a fixture set — a TS function,
  a C++ class with split `.h`/`.cpp` (assert BOTH returned), a C# method, and a GLSL
  `struct`/`void main` (regex tier) — hand-computed expected definition locations.
- **Ranking oracle:** given a fixture file with the symbol appearing in an import line, a
  comment, the definition, and a real call site, `incoming` returns the call site and
  excludes the import/comment/definition. Hand-authored, parser-independent.
- **Portability oracle:** force the `rg`-absent path (simulate ENOENT / point at a dir
  with no rg) and assert `caco.frames` still returns correct frames via `jsGrep` — the
  Windows-without-rg guarantee, tested in CI.
- **Capability check (non-brittle):** on this repo, `frames('recordToolCall')` includes
  the `session-throughput.ts` definition and the `dispatch-events.ts` caller (superset
  assertion, not exact).
- **Scoping check:** a search never descends into `node_modules`/build dirs (assert via a
  fixture with a planted match in an excluded dir that must NOT appear).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **Definition tier** (`src/index/frames.ts`): `findDefinitions(cwd, symbol, opts)` over
   `indexCore` + regex fallback; tests first (the oracle), incl. the C++ `.h`/`.cpp` pair
   and a shader fixture.
2. **Incoming + ranking:** `grepCore` scoped + rank/filter; ranking oracle tests.
3. **Outgoing:** definition-range scan + best-effort resolution; tests.
4. **Snippet assembly + caps + `truncated`/`notes`.**
5. **Portability test:** rg-absent path returns correct frames; scoping excludes build
   dirs. (Hard requirement — gate.)
6. **Facade wiring** (`frames` in Facade/createFacade/accounting/SUMMARY/DTS); one prompt
   line.
7. **Capability check** on this repo + a quick C++ check (hull) + gates.

Proposal A is the highlight; LSP semantic mode is a deferred per-stack opt-in; the JS/WASM
primitive constraint is a hard requirement, not a preference.
