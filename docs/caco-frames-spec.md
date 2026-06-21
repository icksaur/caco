# Spec: `caco.frames` — code navigation via the index facade

## Goal

Collapse the `index → view → view → view …` tool-call chain into **one workflow call**
that returns the code for a symbol's **"stack frames."** A speed *and* cost win with no
tradeoff (fewer round trips; raw search output stays out of context; only chosen snippets
are emitted).

This is the pragmatic unification of B2 (graph) and `index_multiread`: navigation routed
to battle-tested mechanisms, not bespoke semantic analysis.

**Scope split (per spec review):**
- **v1 (this spec):** `definition(s)` + ranked `incoming` callers + code snippets. Fully
  portable, tested, shippable.
- **v2 (deferred):** `outgoing` callees / call graph — needs scope/type/import resolution,
  is noisy and expensive, and is a separate effort. Out of v1.

This document specs v1; the `outgoing`/call-graph design is left as a v2 section stub.

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

**Concrete Windows correctness details (must be handled, not assumed):**
- **Path output normalization:** accept `\` or `/` in the `file`/`glob` inputs; emit all
  `file` paths with `/` separators (POSIX-style) regardless of platform, so results are
  stable across OSes and copy-pasteable into other facade calls.
- **Line endings:** split on `\r?\n` and strip a trailing `\r` so CRLF files yield correct
  line numbers and snippet text (jsGrep currently splits on `\n` only — frames must
  normalize).
- **Glob behavior:** use forward-slash glob patterns (Node `fs.glob` expects POSIX-style);
  translate any `\` in a supplied glob.
- **Case-insensitive filesystems:** dedupe candidate files by normalized (lowercased on
  Win/mac) absolute path so the same file found via two casings is not double-counted.
- **WASM grammar loading:** `web-tree-sitter` loads `.wasm` grammars by path — verify the
  load works on Windows in CI (path resolution to the wasm assets), since a silent load
  failure would drop every tree-sitter definition to the regex tier unnoticed.

## What "stack frames" means here

Given a symbol (and optionally a file to disambiguate):

| Frame kind | How | Tier | Version |
|---|---|---|---|
| **definition** | precise declaration/body location + code | tree-sitter (`caco.index`) where a grammar exists; regex fallback otherwise | **v1** |
| **incoming** (callers) | sites that reference the symbol | `caco.grep` word-boundary, ranked to drop imports/comments | **v1** |
| **outgoing** (callees) | symbols referenced inside the definition's range | needs scope/type/import resolution | **v2 — deferred** |

Output is a compact bundle of `{ kind, file, line, code, confidence }` snippets the model
can read in one shot, with a `truncated` flag and caps on count/snippet size.

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
  include?: ('definition' | 'incoming')[]; // v1: default both. 'outgoing' is v2.
  context?: number;         // lines of code around each site (default ~6)
  maxFrames?: number;       // cap total snippets (default ~20)
  maxFiles?: number;        // hard cap on candidate files indexed/searched (default ~200)
  maxHits?: number;         // hard cap on grep hits considered (default ~500)
}): Promise<{
  symbol: string;
  definitions: Frame[];     // decl + impl (C++ both)
  incoming: Frame[];        // callers, ranked, each with a confidence marker
  truncated: boolean;       // any cap (frames/files/hits) was hit
  notes?: string[];         // e.g. "shader def via regex fallback", "rg absent: JS grep"
}>
// Frame = { kind, file, line, code, confidence: 'exact' | 'heuristic' }
```

`outgoing` is **not** in v1 (see v2 stub). Composed from `caco.index` + `caco.grep` +
`caco.read` + ranking. The model calls one method inside a workflow and `emit`s the slice
it wants.

### Proposal B — documented workflow pattern only (no helper)

Just document "how to gather frames in a workflow" with a snippet. Rejected as primary:
the ranking + C++ pairing + shader fallback + portability scoping is exactly the fiddly
logic that should be written and tested once, not re-derived (buggily) per call — the
same lesson as C1/A3.

### v2 stub — `outgoing` / call graph (DEFERRED)

Outgoing callees ("what does this symbol call?") needs scope/type/import resolution to map
a called identifier to its definition — exactly the semantic analysis tree-sitter can't do
syntactically. A naive "every identifier-call token in the body" list is noisy (locals,
builtins, methods on unknown types) and expensive (resolve each across files). Deferred to
a v2 that either reuses the B2 import resolver for cross-file callees or layers an LSP
backend. Not in v1.

### Semantic precision (LSP: clangd / tsserver / Roslyn) — OUT of scope

True semantic precision (overload/template resolution, exact call hierarchy) needs a
language server: clangd (needs `compile_commands.json`), tsserver, Roslyn/OmniSharp
(needs the .NET SDK + project load). Each is a different **stateful** integration, none
covers shaders, and it violates the "simple, on the shoulders of giants" intent. Defer;
if pursued, it is a per-stack opt-in layered behind the same `caco.frames` shape, not v1.

## Recommended design: Proposal A v1 (definition + incoming), portable

- New module `src/index/frames.ts`: `buildFrames(cwd, symbol, opts)` — pure, tested,
  uses only `indexCore` + `grepCore` + `readFileRangeCore` (the same cores the facade
  wraps), so it inherits the rg→JS fallback and path scoping for free.
- **Hard caps (must, not optional):** cap grep hits (`maxHits`) and the number of
  candidate files indexed (`maxFiles`) — `jsGrep` with no gitignore pruning + `indexCore`
  on every hit file can explode on a large repo. Set `truncated` and record in `notes`
  when a cap bites.
- **Source scoping with explicit excludes (must):** default `glob` to source dirs by
  detected language AND exclude `node_modules`, `.git`, `dist`/`build`/`out`/`bin`/`obj`,
  generated/vendor dirs, and binary files. Source globs alone are not enough — an explicit
  exclude list is required so the JS fallback never descends into build/vendor trees.
- **Definition tier (robust matching, not bare name-equality):**
  - Find candidate files via a scoped `caco.grep` for the **escaped** symbol
    (`\bEscaped\b`), capped at `maxFiles`.
  - `indexCore` each candidate; match a declaration when its **name equals the symbol**
    (escaped/exact), considering **qualified/container names** (C++ `Type::method`, C#
    `Namespace.Class.Method`, TS class methods) so a method isn't missed or mismatched to a
    same-named method in another class.
  - Guard against `index` **maxEntries truncation** dropping the declaration (raise the
    per-file entry budget for this lookup, or detect truncation and fall back to regex).
  - **Ambiguity is explicit:** if the symbol resolves to many definitions (common names
    like `update`/`render`), return them all (capped, `truncated`), do not guess one;
    `file` narrows.
  - For C++: collect BOTH the header declaration and the `Type::method` body.
  - For shader/unknown files (no grammar): regex tier (see Considerations for the pattern
    set).
- **Incoming:** `grepCore('\\b' + escaped + '\\b', { glob })`, capped at `maxHits`, then
  rank/filter: drop pure import/`#include` lines, comment-only lines (handle `//`, `#`,
  `/* */` block comments, and string-literal occurrences best-effort), and the definition
  site itself; prefer call-shaped sites (`symbol(`). Each returned frame carries a
  **`confidence`** marker (`exact` for a clear call site, `heuristic` otherwise) — the
  output must not pretend textual matching is semantic.
- **Snippets:** `readFileRangeCore` a `context`-line window per site (CRLF-normalized).
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
- **Shader/regex tier patterns (don't ship them thin).** Beyond `struct X` / `void main`,
  cover: `<type> name(` function definitions, GLSL `layout(...) uniform/buffer X`,
  uniform/SSBO block names, `#define X`, type constructors, and entry points beyond
  `main` (compute `void main` in `.comp`, named stages). Per-language pattern sets, tested.
- **Reuses the B2 import resolver if/when built** (for the deferred v2 outgoing
  cross-file callees), so the two efforts share code.

## Acceptance

- **Definition-tier oracle (independent):** unit tests on a fixture set — a TS function,
  a C++ class with split `.h`/`.cpp` (assert BOTH returned), a C# method, and a GLSL
  `struct`/`void main` (regex tier) — hand-computed expected definition locations.
- **Ranking oracle:** a fixture file with the symbol appearing in (a) an import/`#include`
  line, (b) a `//` line comment, (c) a `/* */` block comment, (d) a string literal,
  (e) the definition, and (f) a real call site — `incoming` returns the call site (marked
  `confidence: exact`), excludes import/comment/definition, and at worst marks a string
  occurrence `heuristic`. Hand-authored, parser-independent. Include an **overloaded /
  same-name-in-two-classes** fixture (assert both definitions returned, not one guessed)
  and a **CRLF** fixture (correct line numbers).
- **Portability oracle:** force the `rg`-absent path (simulate ENOENT) and assert
  `caco.frames` still returns correct frames via `jsGrep`; assert `file` outputs use `/`
  separators given a `\`-style input — the Windows-without-rg guarantee, in CI.
- **Caps oracle:** a fixture exceeding `maxFiles`/`maxHits` returns `truncated: true` and
  does not index beyond the cap.
- **Capability check (non-brittle):** on this repo, `frames('recordToolCall')` includes
  the `session-throughput.ts` definition and the `dispatch-events.ts` caller (superset
  assertion, not exact).
- **Scoping check:** a search never descends into `node_modules`/build dirs (assert via a
  fixture with a planted match in an excluded dir that must NOT appear).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **Definition tier** (`src/index/frames.ts`): `findDefinitions(cwd, symbol, opts)` over
   `indexCore` + regex fallback; tests first (the oracle), incl. the C++ `.h`/`.cpp` pair,
   qualified/container name matching, the same-name-in-two-classes ambiguity case, and a
   shader fixture. Enforce `maxFiles` and the index-truncation guard here.
2. **Incoming + ranking:** `grepCore` scoped (with the explicit exclude list) + rank/filter
   + `confidence` markers; ranking oracle tests (import/line-comment/block-comment/string/
   def/call-site + CRLF).
3. **Snippet assembly + caps + `truncated`/`notes`** (CRLF-normalized; `/`-style paths).
4. **Portability gate (hard):** rg-absent path returns correct frames; `\`-input →
   `/`-output; scoping excludes `node_modules`/build/vendor; WASM grammar load verified on
   CI. Must pass before facade exposure.
5. **Facade wiring** (`frames` in Facade/createFacade/accounting/SUMMARY/DTS); one prompt
   line.
6. **Capability check** on this repo + a quick C++ check (hull) + gates.
7. **v2 (separate, later):** `outgoing`/call graph — reuse the B2 import resolver; not part
   of this deliverable.

Proposal A v1 (definition + incoming) is the deliverable; `outgoing`/call graph is v2; LSP
semantic mode is a deferred per-stack opt-in; the JS/WASM primitive constraint is a hard
requirement, not a preference.
