# AST index tool

## Goal

Make Caco agents **faster and cheaper** by adding an `index` tool that returns a compact source-file skeleton with exact line ranges, so the agent does bounded `view_range` reads instead of whole-file dumps.

Why this is the highest-leverage lever (see `docs/harness-token-techniques-research.md`):

- An independent replay (Codepointer, 614M tokens) found **~78% of agent tokens flow through native file *Read* tools**, not shell. Shell-output compressors (RTK-class) moved only **0.5–3.7% of total spend**. The read surface is where the tokens are.
- Tilth (a code-nav harness) reports **−40% cost/correct, 76%→86% accuracy, −25% turns** from exactly this skeleton-then-bounded-read pattern.
- Maki reports the index tool adds ~59 tokens/turn but saves ~224 tokens/turn on reads.

Speed follows tokens: fewer/smaller reads mean fewer round-trips and less input to process per turn.

## Design

### Part 1: Caco layer

| Area | Decision |
| --- | --- |
| Tool | Add `index` as a Caco-owned SDK tool via `defineTool`. |
| Input | `{ path: string, language?: string, maxEntries?: number }`; `path` is session-cwd relative or absolute inside the session cwd. |
| Budgets | Default `maxEntries: 200`, output cap `16 KiB`, parse-input cap `1 MiB` for V1. Larger files return a short range-read recommendation, not a full parse. |
| Output | Compact text grouped by `imports`, `types`, `classes`, `interfaces`, `methods`, `functions`, and best-effort `tests`; each item ends with `[start-end]`. |
| Model contract | Tell agents to call `index` before broad file reads for supported source files, then use `view_range` for selected ranges. |
| UI/session output | Keep `textResultForLlm` compact; optionally attach a richer `sessionLog` with parser/language metadata and truncation counts. |
| Safety | Read-only. Reuse `validatePath` so paths outside session cwd are rejected. Return a clear unsupported-language error, not a noisy fallback dump. |
| Extensibility | Caco layer consumes a language-neutral `IndexResult`; language adapters own parsing and extraction. |

`IndexResult` should be boring data:

```ts
type IndexResult = {
  path: string;
  language: string;
  parser: string;
  totalLines: number;
  sections: Array<{
    name: string;
    items: Array<{
      label: string;
      kind: string;
      startLine: number; // 1-based inclusive, matching view_range.
      endLine: number;   // 1-based inclusive, matching view_range.
      children?: Array<{ label: string; kind: string; startLine: number; endLine: number }>;
    }>;
  }>;
  diagnostics: string[];
  truncated: boolean;
};
```

### Part 2: language/platform layer

| Layer | Role |
| --- | --- |
| `LanguageAdapter` | Detect support, parse source, return `IndexResult`. No SDK/tool code. |
| Tree-sitter adapter | Fast syntactic skeletons from `web-tree-sitter` wasm grammars. **The V1 implementation for all four target languages.** |
| Dotnet adapter | Deferred to V2: C#-specific adapter using Roslyn for semantic/project-aware results, only if syntactic C# proves insufficient. |

One adapter (tree-sitter wasm) covers TS/JS/C++/C# with a single architecture. Do not couple the Caco tool to any one language; the model-facing tool consumes `IndexResult`.

## Most reliable tooling — verified

The reliability requirement (must onboard onto a locked-down Windows work machine for the C# office test) rules out anything needing a native toolchain. `web-tree-sitter` wasm is the answer and is **empirically verified** (spike on this machine, Node 26):

- **All target grammars ship prebuilt `.wasm` in their npm tarballs** — no `node-gyp`, no emscripten, no native build. Verified paths: `tree-sitter-cpp/tree-sitter-cpp.wasm`, `tree-sitter-c-sharp/tree-sitter-c_sharp.wasm`, `tree-sitter-typescript/tree-sitter-typescript.wasm` (+`tree-sitter-tsx.wasm`), `tree-sitter-javascript/tree-sitter-javascript.wasm`, runtime `web-tree-sitter/web-tree-sitter.wasm`.
- The spike loaded the C++ and C# grammars and extracted namespaces, classes, structs, records, interfaces, methods, and properties with **correct 1-based line ranges**.
- Onboarding cost = `npm install`. The wasm is bundled; identical behavior Windows/Linux/macOS; no admin rights, no .NET SDK, no MSBuild. This is the decisive advantage over Roslyn for the work machine.

**Pin these versions** (the working, ABI-compatible set from the spike); the `web-tree-sitter` API differs across majors, so lock the runtime and grammars together:

| Package | Version | Notes |
| --- | --- | --- |
| `web-tree-sitter` | `0.26.x` | Named exports `{ Parser, Language }`; `await Parser.init()`, `await Language.load(wasmPath)`. |
| `tree-sitter-cpp` | `0.23.x` | C++ grammar. |
| `tree-sitter-c-sharp` | `0.23.x` | Note wasm filename uses an underscore: `tree-sitter-c_sharp.wasm`. |
| `tree-sitter-typescript` | `0.23.x` | Ships both `tree-sitter-typescript.wasm` and `tree-sitter-tsx.wasm`. |
| `tree-sitter-javascript` | `0.25.x` | JS/JSX grammar. |

## V1 scope and dogfooding plan

V1 ships the uniform tree-sitter adapter for **all four** languages, because the plumbing is shared and the grammars are already proven. Dogfooding is staged to match where each language can be exercised:

| Language | V1 | Where dogfooded | When |
| --- | --- | --- | --- |
| TS/JS | Yes | **Caco's own codebase** (Caco is TS) | Now, at home |
| C++ | Yes | Local C++ projects | Now, at home (a few days) |
| C# | Yes (syntactic) | Office Windows dotnet repos | Next week; pure-wasm install, no .NET toolchain needed |

The TS/JS adapter is the reliability anchor: it can be validated immediately against Caco itself. C++ rides the same path for home testing. C# is shippable in V1 but its real-repo quality is validated at the office — and because it needs only `npm install`, onboarding there is trivial even on a restricted machine.

Optional V2 fidelity upgrades, both deferred and behind adapter seams:
- **TS/JS:** swap to the TypeScript compiler API (Caco already depends on `typescript@5.9.3`) for semantic-grade output, if syntactic skeletons miss anything that costs reads.
- **C#:** Roslyn adapter for partial classes, generated code, and symbol/reference data, if real dotnet repos show costly syntactic misses.

Tree-sitter implementation rules:

- Use `web-tree-sitter@0.26.x` with the named exports `{ Parser, Language }`. Call `await Parser.init()` once at startup, then `await Language.load(wasmPath)` per grammar. (Older majors use a default export and `Parser.Language.load`; do not mix.)
- Resolve grammar wasm from installed `node_modules`. Verified paths: `tree-sitter-c-sharp/tree-sitter-c_sharp.wasm` (underscore, not hyphen), `tree-sitter-typescript/tree-sitter-typescript.wasm`, `tree-sitter-typescript/tree-sitter-tsx.wasm`, `tree-sitter-javascript/tree-sitter-javascript.wasm`, `tree-sitter-cpp/tree-sitter-cpp.wasm`.
- Do not use native `.node` bindings. The npm packages include them, but Caco's portability contract is wasm-only — this is what makes Windows onboarding `npm install`.
- Initialize the runtime once per server process and cache loaded `Language` objects by grammar. Never `Parser.init()` or `Language.load()` per tool invocation.
- Convert tree-sitter rows to 1-based inclusive line ranges at the adapter boundary (`node.startPosition.row + 1`). Verified correct in the spike.
- Keep parsing synchronous only below the V1 parse-input cap. If real repos need larger files, move parsing to a worker thread before raising the cap.

## Runtime model, lifecycle, and concurrency

This is the section that answers "what happens while indexing." The key decision: **V1 is on-demand, per-file, stateless parsing — not a background repo crawler.** There is no persistent index to be "not started," "in progress," or "stale." Each `index` call parses exactly one file and returns; the result is not retained.

| Question | V1 answer |
| --- | --- |
| When does indexing start? | When the `index` tool is called, on that one file. No directory crawl, no watcher, no startup scan. The name "index" means "produce a skeleton index *of this file*" (as in Maki), not "maintain a repo-wide index." |
| What state can the tool be in (not started / in progress / done)? | None of these exist. A call either returns an `IndexResult` or a clear error. There is no lifecycle to query. |
| What is cached? | Only **immutable, reusable** runtime state: the `web-tree-sitter` runtime (one `Parser.init()` per process) and loaded `Language` objects (one `Language.load()` per grammar). Both are lazy: the first `index` call for a given language pays a one-time millisecond cost; later calls reuse. Parse **results are not cached** in V1 — parsing a normal file is sub-10ms, and skipping a result cache removes the entire stale-cache risk class. |
| Does it index non-code? | No. The tool takes a single file path and detects language by an extension allowlist *before* parsing. Unknown extension, directory, or oversized/binary file → short error, **no parse, no crawl**. |
| Can multiple agents/sessions share it across threads? | There is no shared *mutable* index. Node runs JS single-threaded, so concurrent `index` calls serialize on the event loop; each produces its own independent result. The only shared state is the read-only `Language` cache, which is safe to share. A stateful `Parser` is **not** shared concurrently (see below). |

**Initialization (single-flight, lazy, fault-isolated):**
- Memoize the `Parser.init()` promise and each `Language.load(grammar)` promise so concurrent first-calls trigger exactly one init (no init race).
- Wrap init/load in try/catch. A grammar that fails to load is marked unavailable for the process and returns a clean "language unavailable" diagnostic; it never crashes the server or other languages.

**Concurrency model:**
- V1: parse synchronously on the main thread. Because JS is single-threaded and the parse call blocks, calls are naturally serialized — no Parser is ever used by two calls at once. Use a fresh `Parser` per call (or a tiny single-threaded reuse) and **discard the returned tree immediately after extraction** (no incremental/edit reuse in V1) so no tree memory is retained.
- The event-loop-stall risk (one Node process serves all sessions; a big synchronous parse blocks everyone) is bounded by the parse-input cap (1 MiB): oversized files are rejected with a range-read recommendation, never parsed inline.
- V2 scaling path: a worker-thread pool. wasm linear memory is **not** shared across threads, so each worker loads its own runtime + grammar copies (bounded: 4 small grammars per worker). Workers return plain `IndexResult` data to the main thread; there is still no shared mutable index. Only introduce this if real workloads show main-thread stalls.

**Multi-agent / fan-out in the same directory:**
- Safe by construction in V1. The tool is a pure read-only function `(path, bytes) → IndexResult` with no writes and no shared *mutable* state, so concurrent calls from many sessions/agents on the same directory cannot stomp each other. No file locks, no coordination, no per-session isolation needed.
- "Stomping" is a **write** concern (two agents editing the same file). The `index` tool neither causes nor mitigates it; that belongs to edit/write coordination and is out of scope here. Worth stating so fan-out users don't assume `index` provides any write safety.
- The only shared resource a fan-out contends for is the single Node event loop (CPU). Concurrent parses serialize and each blocks the loop for its duration, so heavy fan-out amplifies the event-loop-stall concern — bounded by the parse-input cap in V1, and naturally parallelized by the worker pool in V2. This is a throughput limit, never a correctness/stomping issue.
- The process-global `Language` cache is shared read-only across all sessions in one Caco process (efficient); separate processes simply hold their own copies. Both are safe.
- Software read-caching of file bytes or results is **not worth it in V1**: the OS page cache already serves repeated reads, and a per-file parse is sub-10ms. Software caching (with its invalidation/ownership cost) only earns its keep at the cross-file call-graph layer — which is exactly where a persistent shared structure forces the concurrency/locking model (see Future direction: repo-level index).

**Memory:** bounded and small — one runtime + at most four loaded grammars per process (×N workers in V2). No per-file accumulation because results and trees are not retained.

## Future direction: repo-level index

The V1/V2 items above (Roslyn, TS compiler API, worker pool) all improve *per-file* quality or throughput — the tool stays strictly per-file. A genuinely deeper, **cross-file repo index** is a separate, later layer. It is intentionally not in V1, but the design leaves the door open without painting us into a corner.

What tree-sitter actually gives us here, to set expectations:

- Tree-sitter parses **one file → one syntax tree**. It has **no** cross-file model and **no** semantic symbol resolution. It cannot, by itself, "traverse a tree via a shared index."
- The proven pattern (Aider's repo-map, GitHub/Sourcegraph code-nav) is: run a per-file **tags query** (`tags.scm`) to extract *definitions and references*, aggregate those across all files into a symbol table, link references→definitions by **name matching** (syntactic, not semantic), then **rank** (e.g. PageRank over the symbol graph) and emit a token-budgeted repo map. Semantic-grade cross-file linking (overloads, partial classes, generics) needs Roslyn/TS-API, not tree-sitter.

So a repo index would be an **aggregation + storage + ranking layer built on top of the V1 primitive**, not a parser change. The language-neutral `IndexResult` and `LanguageAdapter` seam are exactly the reusable building blocks: V1 produces per-file structure; a repo index would collect many of them.

Crucially, this layer **reintroduces every risk V1 designed away** — the persistent, mutable, shared index whose absence makes V1 simple. Adopting it is a deliberate, opt-in project that must independently answer:

| Concern | What the repo-index layer must define |
| --- | --- |
| Lifecycle | When the crawl starts (lazy on first repo-query vs background), and the not-built / building / ready states the V1 tool never has. |
| Staleness/invalidation | How edits invalidate entries — file watcher, mtime/hash checks, or re-index on demand. This is the hard part. |
| Persistence | Whether the index lives in memory only or on disk (e.g. under the session/workspace), and how it is keyed to a repo + commit. |
| Concurrency | A genuinely shared structure read by many sessions/threads — needs an ownership/locking model, unlike V1's serialized per-call parses. |
| Memory/scope | Budget for large monorepos; likely scoped to a subtree or gated by repo size. |
| Cost/ROI | Whether cross-file answers (find-callers, find-definition) actually prevent enough reads to justify the build + maintenance cost. |

Recommendation: ship V1 (per-file), instrument real usage, and only pursue the repo index if traces show the agent repeatedly hunting *across* files (e.g. "where is this called?") in a way per-file indexing plus grep cannot cheaply serve. Treat it as its own spec, not a V1 stretch goal.

## C# / dotnet expectations

| Option | Expected performance | Expected quality | Cost |
| --- | --- | --- | --- |
| `tree-sitter-c-sharp` via wasm | Fast enough for capped per-file interactive use; no project load; deterministic on Windows/Linux. | Good syntax skeleton: namespaces, using directives, classes, records, interfaces, enums, methods, properties, best-effort tests. Handles preprocessor blocks per grammar; not semantic. | Low Caco complexity; one Node dependency path shared with TS/JS/C++. |
| Roslyn syntax-only helper | Usually fast for one file, but needs a .NET helper process or package restore path. | Better C# syntax fidelity and trivia handling; still not semantic unless project is loaded. | Medium complexity: process management, packaging, cross-platform install/version behavior. |
| Roslyn project/workspace helper | Slower cold start; can be excellent if kept warm and scoped. Project load/restore can dominate. | Best quality: partial classes across files, generated sources, symbols, references, inheritance, nullable context, analyzer data. | High complexity: SDK discovery, solution/project load failures, target frameworks, NuGet restore, MSBuild state, Windows/work policy variance. |

Expected V1 quality from tree-sitter C# should be good for Caco's efficiency goal: identify where to read next. It should not promise "go to definition", references, symbol resolution, generated code, or cross-file partial type merging. That is acceptable because the token-saving use case is file triage, not IDE replacement.

For work dotnet users, Roslyn may be worth a V2 if the missing semantic answers cause repeated large reads. The wrapper should be treated as a separate adapter with a clear feature gate, not as the default dependency.

## Tree-sitter vs tech-specific tooling

| Choice | Pros | Cons |
| --- | --- | --- |
| Node + tree-sitter only | One architecture; works for TS/JS/C++/C#; fast cold path; wasm avoids native build friction; mirrors Maki's token-saving strategy. | Syntax only; per-language extractors still need maintenance; C#/.NET project concepts are invisible. |
| Tech-specific wrappers | Higher-quality answers for ecosystems like .NET; can expose semantic facts that prevent follow-up reads. | Each ecosystem becomes a product: install, versioning, process lifecycle, cache invalidation, project-load errors, and security review. |

Recommendation: implement the Caco layer plus tree-sitter adapters first. Treat dotnet/Roslyn as a measured second adapter only after real C# users show tree-sitter misses that cost enough tokens/time to justify the complexity.

## Code analysis

| File/area | Current behavior | Needed change |
| --- | --- | --- |
| `src/*tool.ts` | Caco custom tools are SDK `defineTool` factories returning `textResultForLlm`. | Add `src/index-tool.ts` with read-only path resolution and compact output formatting. |
| Tool factory wiring | Session create/resume receives a `toolFactory(sessionCwd, sessionRef)` array. | Add `createIndexTool(sessionCwd)` to the common tool list. |
| `src/prompts.ts` | System prompt tells agents they can read/search files but has no index guidance. | Add terse guidance: call `index` before broad reads on supported source files. |
| Dependencies | No parser dependency today. | Add `web-tree-sitter` and `tree-sitter-*` grammar packages whose npm tarballs include the required wasm files. |
| Tests | No AST/index tests. | Add golden tests per language and adapter-level line-range invariants. |

## Acceptance

| Case | Oracle |
| --- | --- |
| Tool output is compact and stable | Golden snapshot for hand-written TS, JS, C++, and C# fixtures. |
| Line ranges are correct | Independent oracle reads fixture lines and asserts each label's range contains the declaration text. |
| C# V1 handles common dotnet code | Dummy `dotnet new` project plus fixture with namespace, using, class, record, interface, enum, properties, async method, test method, preprocessor block. |
| Unsupported files are safe | Unit test returns a short unsupported-language error and no file dump. |
| Windows/Linux portability | Tests use wasm grammar loading, not native `.node` bindings or platform-specific paths. |
| Token-efficiency intent holds | Snapshot output for a representative source file is materially smaller than full file content and includes enough ranges to support targeted `view_range`. |
| Range reads are available | Smoke test or documented verification that the Caco runtime's file-view/read surface supports 1-based bounded line reads. |
| Tree-sitter row conversion is correct | Adapter invariant test proves a 0-based parser row becomes a 1-based inclusive `IndexResult` line. |
| Init is single-flight | Fire N concurrent first-calls for one language; assert `Parser.init()`/`Language.load()` run once (spy/counter). |
| Bad grammar is isolated | Simulate a failing `Language.load`; assert the call returns a clean diagnostic and other languages still work. |
| No tree/result retained | After an `index` call, assert no parse tree or per-file result is held (e.g. cache size stays 0; only grammar cache grows). |

## Risks

| Risk | Mitigation |
| --- | --- |
| Agent assumes a persistent repo index exists. | Document/describe `index` as a per-file, on-demand skeleton (no crawl, no lifecycle). Tool description states it parses one file per call. |
| C# users expect IDE semantics. | Name/document V1 as syntactic `index`; reserve Roslyn for a future `dotnet` adapter. |
| Wasm grammar loading is brittle after packaging. | Centralize grammar path resolution and test from installed `node_modules` layout. |
| Concurrent first-calls race on init. | Single-flight: memoize the `Parser.init()` and per-grammar `Language.load()` promises. |
| A bad/corrupt grammar load crashes the server. | Fault isolation: try/catch around init/load; mark that language unavailable for the process and return a clean diagnostic. |
| Concurrent calls corrupt shared parser state. | Never share a stateful `Parser` across concurrent calls; share only the immutable `Language` cache. Parses serialize on the single JS thread. |
| Retained parse trees leak memory. | Discard the tree immediately after extraction; no incremental/edit reuse and no result cache in V1. |
| Stale results after a file changes. | No result cache in V1 — every call re-parses current bytes, so results can never be stale. |
| Tool is pointed at non-code/binary/a directory. | Extension allowlist + size cap + reject directories *before* parsing; short unsupported error, no parse. |
| Extractors become a parallel parser product. | Keep V1 extraction shallow: declarations, imports, ranges; no deep semantic modeling. |
| Tool saves tokens only if agents use it. | Add concise prompt guidance and tool description examples; measure later with session traces. |
| Large generated files stall the Node event loop (blocks all sessions). | Conservative parse-input cap (1 MiB) returns a range-read recommendation instead of parsing; worker-thread pool is the V2 scaling path before raising the cap. |
| Large files produce huge indexes. | Entry and byte budgets with explicit truncation counts. |

## Plan

- [x] Parser spike: load `tree-sitter-cpp.wasm` and `tree-sitter-c_sharp.wasm` via `web-tree-sitter@0.26`, extract declarations with line ranges. **Done — verified working, ranges correct.**
- [x] Decide V1 language set: **uniform tree-sitter for TS/JS/C++/C#** (shared plumbing, grammars proven). Roslyn/TS-compiler-API deferred to V2 behind adapter seams.
- [x] Add the pinned deps (`web-tree-sitter`, `tree-sitter-{cpp,c-sharp,typescript,javascript}`) and a wasm path resolver that works from the installed `node_modules` layout.
- [x] Add singleton tree-sitter runtime initialization (`Parser.init()` once, single-flight) and per-language wasm `Language` cache, with try/catch fault isolation per grammar.
- [x] Add `LanguageAdapter`, `IndexResult`, and formatter; golden-fixture tests per language.
- [x] Add line-range invariant tests (parser row +1 == 1-based inclusive `view_range`).
- [x] Add the `index` SDK tool and wire it into the default tool factory.
- [x] Add prompt/tool-description guidance to prefer `index` before broad source reads.
- [x] Add C# fixture coverage for common dotnet constructs and preprocessor blocks.
- [x] Add unsupported-language, outside-cwd, missing-file, parse-size-cap, output-budget, and truncation tests.
- [ ] Verify bounded range reads in the Caco runtime so `index` can actually reduce follow-up read tokens.
- [x] Run typecheck, lint, focused tests, and full unit tests.
- [ ] Dogfood: TS/JS on Caco itself + C++ locally (home, now); validate C# on office dotnet repos (next week).
- [ ] Reassess V2 (Roslyn for C#, TS compiler API for TS/JS) only after dogfooding shows costly syntactic misses.
- [ ] Reassess a repo-level index (separate spec) only if traces show repeated cross-file hunting that per-file index + grep cannot cheaply serve.
