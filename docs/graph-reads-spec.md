# Spec: graph reads via the index facade (B2)

## Goal

Let an agent get a **dependency/import graph** of the codebase in one workflow call —
"what imports X", "what does X depend on", "is there a cycle", "blast radius of
changing X" — without N greps+reads, and returning compact **edges**, not file bodies.
Build it on the existing `index` tree-sitter pipeline; expose it through the
`caco_run_workflow` facade (no new top-level tool).

## Why edges, and why now (with an honest caveat)

The prior `docs/ast-index-tool-spec.md` cites independent research: **~78% of agent
tokens flow through file *Read* tools**, and skeleton-then-bounded-read patterns cut
~25% of turns. Reads are where the spend is. A dependency graph attacks a slice of that
— but a **narrow, specialized slice** (structural navigation), not the general read
surface.

**Caveat the user should weigh:** the user's own stated next priority was
`index_multiread` (read many snippets with logic), which attacks the *general* read
surface directly. A dependency graph is higher-ceiling for refactor/impact questions but
lower-frequency than "read these 5 things at once." This spec delivers B2 as asked, but
flags that `index_multiread` may be the higher-value read-reducer — see Considerations.

## What the index pipeline already gives us

- `indexCore(cwd, path, opts)` parses ONE file via tree-sitter into an `IndexResult`
  with sections; **imports are already captured** (as raw statement text:
  `import { x } from './y.js'`, `#include`, `using`, etc.).
- It is already in the workflow facade as `caco.index(path)`, plus `caco.glob` for file
  discovery. So a dependency graph is an **aggregation over `caco.index` calls** — the
  fan-out the workflow exists for. The missing pieces are (a) parsing the import
  *specifier* out of each import, and (b) resolving it to a repo file.
- No import-resolution or graph code exists today (verified) — this is net-new.

## The hard part: import resolution

A useful edge is `src/a.ts → src/b.ts`, not `src/a.ts → './b.js'`. Resolution must
handle this repo's realities:
- **ESM `.js`→`.ts` quirk:** this codebase imports `'./tree-sitter-adapter.js'` for a
  file that is `tree-sitter-adapter.ts`. Naive resolution misses every edge.
- Extensionless / index files, `.tsx`, `.mts`/`.cts`.
- External vs internal: `node_modules` / bare specifiers → collapse to a single
  `external:<pkg>` node or drop, don't try to resolve.
- Path aliases (tsconfig `paths`) — out of scope for v1; note as a limitation.

Getting this right once in a tested helper is the whole value over an ad-hoc grep the
model re-derives (buggily) each time.

## Proposals

### Proposal A — `caco.graph()` facade method (RECOMMENDED)

Add a facade method (no new top-level tool → zero schema tax, consistent with the diet):

```ts
caco.graph(opts?: {
  glob?: string;          // files to include; default the language's source glob
  direction?: 'imports' | 'importedBy' | 'both';
  root?: string;          // focus the graph on one file's neighborhood
  depth?: number;         // transitive hops from root (default 1; Infinity for full)
}): Promise<{
  nodes: string[];                       // repo-relative paths (+ external:<pkg>)
  edges: Array<[from: string, to: string]>;
  cycles?: string[][];                   // detected import cycles
  unresolved?: Array<[from: string, specifier: string]>;
}>
```

Implemented as: `glob` files → `indexCore` each → pull import specifiers → resolve →
emit edges. Compact (edges, not bodies). Transitive queries (`root`+`depth`, `cycles`)
are the real value over grep. The model calls it inside a workflow and `emit`s the slice
it needs.

### Proposal B — importable helper module, no facade surface

Ship `buildImportGraph()` in `src/index/` and document it so a workflow does
`const { buildImportGraph } = await import('../src/index/import-graph.js')`. Lighter
(no facade type/description bytes), but discovery is worse (the model won't know it
exists without prompt/doc support) and the dynamic-import path inside the sandbox is
clunky. Weaker than A on usability.

### Proposal C — documentation pattern only (no code)

Just document "how to build a dep graph in a workflow" with a copy-paste snippet using
`caco.index` + a resolver the model writes inline. Rejected: the resolver is the hard,
error-prone part (the `.js`→`.ts` quirk); making the model re-derive it every time is
exactly the unreliability we avoid elsewhere. Pure-doc has no tested resolver.

### Call graph — explicitly OUT of scope for v1

A true call graph needs **semantic** resolution (which definition does `foo()` call?
scope + type analysis across files). Tree-sitter is **syntactic only** — it can list
"identifiers called inside function F" but cannot reliably map them to definitions. A
syntactic approximation is noisy enough to mislead. Defer; if pursued later, scope it as
"intra-file call references" or pair it with an LSP/semantic backend, not tree-sitter
alone.

## Recommended design: Proposal A (`caco.graph`), imports only, v1

- New module `src/index/import-graph.ts`: `buildImportGraph(cwd, opts)` — pure, tested.
  - **Specifier extraction:** per language, pull the module string from each captured
    import (regex on the raw import text is sufficient and robust; the import section is
    already isolated by tree-sitter, so we are not regexing whole files).
  - **Resolver:** internal `resolveSpecifier(fromFile, specifier)` handling `.js`→`.ts`,
    extensionless, `index.*`, `.tsx`/`.mts`/`.cts`; bare specifiers → `external:<pkg>`;
    unresolved → recorded in `unresolved[]`, never thrown.
  - **Graph ops:** adjacency build, `importedBy` inversion, BFS for `root`+`depth`,
    cycle detection (DFS) when requested.
  - **Caps:** a max-files budget (reuse/extend index caps) so a huge tree can't blow
    memory; return `truncated` when hit.
- Facade wiring in `src/workflow/facade.ts`: add `graph` to `Facade`, `createFacade`,
  `wrapFacadeForAccounting` (the typed wrapper forces this — good), `FACADE_API_SUMMARY`,
  and `FACADE_DTS`.
- Workflow tool description / prompt: one line that `caco.graph` builds an import graph
  for impact/dependency questions.

## Considerations

- **Tree-sitter is syntactic.** Imports are reliably extractable (they're declarations);
  call graphs are not. v1 is honest about being an *import* graph.
- **Resolution is best-effort.** `unresolved[]` is a first-class output, not a failure;
  tsconfig path aliases and dynamic `import()` strings are v1 limitations to document.
- **External nodes.** Collapse `node_modules`/bare specifiers to `external:<pkg>` (or a
  flag to drop them) so the graph stays about *your* code.
- **Cost honesty.** Building the graph indexes many files in the child process — but that
  cost stays *in the workflow* and only the compact edge set is emitted. This is the
  workflow's sweet spot. The byte oracle can't measure facade methods (they're not
  `defineTool`); value is shown by the use-case, not a byte delta.
- **Is B2 the right next thing?** Per the user's own research, the general read surface
  (→ `index_multiread`) may pay back more broadly than a specialized graph. A dependency
  graph wins for refactor/impact/cycle questions specifically. If those aren't frequent
  in the user's work, `index_multiread` is the better next pick. Flagged for decision.
- **No mid-session anything.** Pure facade addition; no registration/lifecycle concerns.

## Acceptance

- **Resolver oracle (independent):** unit tests on `resolveSpecifier` with hand-computed
  expected targets — the `.js`→`.ts` quirk, `index.ts`, `.tsx`, `.mts`, a bare specifier
  → `external:`, and an unresolved path → `unresolved[]`. This is the make-or-break part;
  test it hardest.
- **Graph oracle:** on a tiny fixture tree (3–4 files with known imports incl. a cycle),
  `buildImportGraph` returns exactly the expected nodes/edges/cycles. Independent of the
  parser (hand-authored fixture + hand-computed expected graph).
- **Facade integration:** a workflow calling `caco.graph({ root, depth: 1 })` returns the
  expected neighborhood; `importedBy` inversion verified.
- **Capability check:** reproduce a real query on this repo — e.g. "what imports
  `session-throughput.js`" matches the known 3 importers (dispatch-events,
  session-runtime, request-metrics-log) found earlier this session.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **Resolver** (`src/index/import-graph.ts`): `resolveSpecifier` first, test-first (the
   oracle). Handle the `.js`→`.ts` quirk + the enumerated cases.
2. **Specifier extraction** per language from the existing import captures; tests.
3. **Graph build + ops** (adjacency, `importedBy`, BFS depth, cycle detect, caps); tests
   on the fixture tree.
4. **Facade wiring** (`graph` in Facade/createFacade/accounting/SUMMARY/DTS); one prompt
   line.
5. **Capability check** on this repo (the importers query) + gates.
6. **Decision point:** confirm with the user that B2 (graph) is preferred now over
   `index_multiread`; the resolver work is reusable either way.

Proposal A is the highlight; call graph is out of scope; `index_multiread` is the
flagged alternative if dependency queries aren't frequent enough to justify B2 first.
