# Custom-instruction file loading — GitHub Copilot CLI & Copilot Agent SDK

## 0. Scope correction (important)

- `@github/copilot` is **not** installed in `~/repo/caco/node_modules/`. The real installed artifact is the platform binary package **`@github/copilot-linux-x64` v1.0.65**, whose `package.json` declares `"repository": "git+https://github.com/github/copilot-cli.git"` and exports `"./sdk" → { types: "./sdk/index.d.ts", import: "./sdk/index.js" }`.
- `~/repo/caco/package.json` declares `"@github/copilot-sdk": "1.0.4"` (a thin RPC client), not `@github/copilot`.
- `app.js` is the minified CLI runtime; `sdk/index.d.ts` (~29.5k lines, unminified, richly commented) is the best semantic source. Identifiers cited from `app.js` are minifier-mangled; line numbers are coarse because the bundle has multi-MB lines.
- **No shell tool available**, so `npm root -g` / `which copilot` were not checked — the globally installed `copilot` binary may be a different version than 1.0.65 (docs and issue #3987 indicate 1.0.66/1.0.67 exist and changed one behavior; see §8).
- **No runtime experiment was performed.** Nothing here is "(observed by me)"; findings are labeled **(a) documented**, **(b) code-evidenced**, **(c) community claim**.

---

## 1. Answers to the five numbered questions

<table>
<thead><tr><th>#</th><th>Location</th><th>Auto-injected (no tool call)?</th><th>When / how</th><th>Evidence</th><th>Label</th></tr></thead>
<tbody>
<tr>
<td>1</td><td><code>~/.copilot/copilot-instructions.md</code></td>
<td><b>YES</b> — eagerly at session start</td>
<td>Loaded into the system prompt's <code>custom_instructions</code> section as source <code>{id:"home-copilot", type:"home", location:"user"}</code>. Honors <code>COPILOT_HOME</code>.</td>
<td>(b) <code>app.js:119</code> fns <code>a6n()</code> / <code>WDe()</code>, path built via <code>Po(t,"config")</code>; also <code>app.js:~2984</code> <code>/help</code> list. (a) docs table row "<code>$HOME/.copilot/copilot-instructions.md</code> — User-level instructions that apply across repositories."</td>
<td>(a)+(b)</td>
</tr>
<tr>
<td>2</td><td><code>&lt;cwd&gt;/AGENTS.md</code></td>
<td><b>YES</b> — eagerly at session start</td>
<td>Loaded for BOTH git root and cwd (and every intermediate dir between them). Source type <code>model</code>, id <code>cwd-*</code> / repo-level.</td>
<td>(b) root convention table <code>Oht</code> at <code>app.js:119</code>: <code>{filename:"AGENTS.md", conventionDir:"", type:"model", grouping:"model"}</code>; loaded by <code>wht()</code> called twice from <code>Z9n()</code> (repoRoot, then cwd with <code>"cwd-"</code> prefix). (a) docs: "<code>AGENTS.md</code> — Agent instructions, discovered in the standard locations."</td>
<td>(a)+(b)</td>
</tr>
<tr>
<td>3</td><td><code>&lt;cwd&gt;/somedir/AGENTS.md</code> (descendant)</td>
<td><b>CONDITIONALLY YES — but only after a successful <code>view</code> of a file in that subtree.</b> NOT loaded at session start.</td>
<td>On-demand discovery: after the <code>str_replace_editor</code> tool's <code>view</code> command succeeds, the runtime walks up from <code>dirname(file)</code> collecting instruction files and injects <b>full content</b> as a hidden follow-up user message. <b>Editing/creating/grepping a file does NOT trigger it</b> — only <code>view</code>.</td>
<td>(b) <code>Uht</code>/<code>l6n</code>/<code>c6n</code>/<code>$ht</code> at <code>app.js:119</code>; hook call site in <code>str_replace_editor</code> (<code>MHe</code>) <code>app.js:~1742</code> guarded by <code>resultType==="success" && command==="view"</code>. <code>sdk/index.d.ts:29389-29401</code>: <code>triggerTool</code> — "Tool command that triggered discovery <b>(currently always 'view')</b>". (a) docs: standard locations include "<b>any directories nested in the path of a file it is working on</b>".</td>
<td>(a)+(b)</td>
</tr>
<tr>
<td>4</td><td><code>&lt;cwd&gt;/copilot-instructions.md</code> (root, NOT under <code>.github/</code>)</td>
<td><b>NO</b></td>
<td>Never recognized. Only <code>.github/copilot-instructions.md</code> is. A bare root-level file is invisible to the loader.</td>
<td>(b) absent from both convention tables — <code>Oht</code> entry is <code>{filename:"copilot-instructions.md", conventionDir:".github", ...}</code>; <code>Dht</code> entry is <code>{kind:"copilot", convention:".github", filename:"copilot-instructions.md"}</code> (<code>app.js:119</code>). (a) docs table lists only <code>.github/copilot-instructions.md</code> and <code>$HOME/.copilot/copilot-instructions.md</code>.</td>
<td>(a by omission)+(b)</td>
</tr>
<tr>
<td>5</td><td><code>&lt;cwd&gt;/somedir/copilot-instructions.md</code></td>
<td><b>NO</b></td>
<td>Same reason. Even the on-demand ancestor walk uses <code>Dht</code>, which requires the <code>.github/</code> convention dir. <code>&lt;cwd&gt;/somedir/.github/copilot-instructions.md</code> <i>would</i> be discovered on-demand; the bare file would not.</td>
<td>(b) <code>Dht</code> + <code>l6n</code> at <code>app.js:119</code></td>
</tr>
<tr>
<td>—</td><td><code>&lt;cwd&gt;/.github/copilot-instructions.md</code></td>
<td><b>YES</b> — eagerly at session start</td>
<td>First entry in the root convention table; loaded for git root AND cwd. Type <code>repo</code>, grouping <code>copilot</code>, <code>preferredForCreation:true</code>.</td>
<td>(b) <code>Oht[0]</code> + <code>s6n()</code> at <code>app.js:119</code>; named in <code>sdk/index.d.ts:28898-28899</code> doc comment and in <code>/help</code>. (a) docs table row.</td>
<td>(a)+(b)</td>
</tr>
</tbody>
</table>

**Key mental model:** eager loading covers **the git root, the cwd, and every directory *between* them (ancestors)**. Descendants of cwd are *not* eagerly loaded — they arrive only via on-demand discovery, triggered by `view`.

Corroborating (c): github/copilot-cli#1655 was closed with a maintainer comment — *"This should be resolved as of v1.0.11. The CLI now discovers AGENTS.md files (and other custom instructions) at every directory level **from the working directory up to the git root**"* ([issue #1655 comment](https://github.com/github/copilot-cli/issues/1655#issuecomment-4199570346)). And #3051 *"Recursively discover AGENTS.md in subfolders, like VS Code's `chat.useNestedAgentsMdFiles`"* is **still open** — i.e. eager recursion into subfolders is not implemented.

---

## 2. Full set of eagerly-discovered locations (v1.0.65)

Root convention table `Oht` (`app.js:119`) — checked at git root and at cwd:

```js
[{filename:"copilot-instructions.md", conventionDir:".github", type:"repo",  grouping:"copilot", preferredForCreation:true},
 {filename:"AGENTS.md",  conventionDir:"", type:"model", grouping:"model"},
 {filename:"CLAUDE.md",  conventionDir:"", type:"model", grouping:"model"},
 {filename:"GEMINI.md",  conventionDir:"", type:"model", grouping:"model"}]
```

Per-directory ancestor-walk table `Dht` (`app.js:119`) — used both for intermediate dirs and for on-demand discovery:

```js
[{kind:"copilot", convention:".github", filename:"copilot-instructions.md"},
 {kind:"agents",  convention:".",       filename:"AGENTS.md"},
 {kind:"claude",  convention:".",       filename:"CLAUDE.md"},
 {kind:"claude",  convention:".claude", filename:"CLAUDE.md"},
 {kind:"gemini",  convention:".",       filename:"GEMINI.md"}]
```

Official docs table (a) — <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>:

> "Copilot CLI discovers repository and agent instruction files in the **standard locations**: the repository root, the current working directory, intermediate directories between them, and any directories nested in the path of a file it is working on."

| Location | Doc'd scope |
|---|---|
| `$HOME/.copilot/copilot-instructions.md` | user-level, across repos |
| `$HOME/.copilot/instructions/**/*.instructions.md` | modular user-level |
| `.github/copilot-instructions.md` | repo-wide, standard locations |
| `.github/instructions/**/*.instructions.md` | modular, standard locations **but not intermediate directories** |
| `AGENTS.md` | standard locations |
| `CLAUDE.md` | standard locations; also `.claude/CLAUDE.md` |
| `GEMINI.md` | standard locations |
| dirs in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | extra `AGENTS.md` + `*.instructions.md`, comma-separated |

Docs also confirm `COPILOT_HOME` overrides `$HOME/.copilot` for both user-level locations, and that `/instructions` lists and toggles discovered files.

The in-product `/help` list (`app.js:~2984`) matches this table exactly — useful independent corroboration.

---

## 3. `skipCustomInstructions` and `enableOnDemandInstructionDiscovery`

### `skipCustomInstructions?: boolean` — **(b), default `false`**

Appears in `sdk/index.d.ts` at:
- `:25719-25720` (`SessionOpenOptions`) — "Whether to skip custom instruction sources."
- `:26057` (session create options, next to `instructionDirectories`, `organizationCustomInstructions`, `disabledInstructionSources`)
- `:27140-27141` (options-update) — "Whether to skip loading custom instruction sources."
- `:28898-28899` (`SubagentSessionOptions`) — "Whether to skip loading custom instructions (repo-level .github/copilot-instructions.md, etc.)."
- `:22720` — `protected skipCustomInstructions: boolean` on the session base class.

Runtime effect (`app.js:~723`, system-prompt assembler `jee`): `let re = l ? Promise.resolve(undefined) : ER(t, true, n, u, {...})` where `l = skipCustomInstructions` and `ER` is the entire eager instruction loader. So `true` ⇒ **zero** instruction files loaded.

### `enableOnDemandInstructionDiscovery?: boolean` — **(b), default `false` at SDK level**

`sdk/index.d.ts:25983-25991`:

> "Whether to discover custom instructions on demand after successful file views (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md surfacing). Combined with `skipCustomInstructions` and the runtime-side ON_DEMAND_INSTRUCTIONS feature flag. **Defaults to false. CLI sessions opt into this by spreading `cliSessionDefaults()`.**"

Also `:25653-25654` and `:27082-27083` (options-update variant), and `:28900-28908` (subagent) — "Defaults to inheriting the parent session's setting. Effective behavior also requires `skipCustomInstructions` to be false and the `ON_DEMAND_INSTRUCTIONS` feature flag to be granted (gated at `buildSettingsAndTools()`)."

**Three-way gate, confirmed in the bundle** (`app.js:~3323`) — `onFileAccessed` is set to `undefined` when:

```
!this.enableOnDemandInstructionDiscovery || this.skipCustomInstructions || !this.featureFlags?.ON_DEMAND_INSTRUCTIONS
```

Feature-flag availability table `JB` (`app.js:~1084`):
- `ON_DEMAND_INSTRUCTIONS: {availability:"on", capiSanity:false}` → **granted to everyone by default**
- `CHILD_CUSTOM_INSTRUCTIONS: {availability:"staff", capiSanity:true}` → **staff-only**
- `DYNAMIC_INSTRUCTIONS_RETRIEVAL{,_MCP,_BLACKBIRD}: {availability:"off"}`

⇒ **For the interactive/CLI agent this is ON. For a plain SDK caller it is OFF unless you set it (or spread `cliSessionDefaults()`).** This is the single biggest behavioral difference between `copilot` the CLI and `@github/copilot` used programmatically.

### On-demand mechanics — **(b)**

- State (`Bht()`): `{sources:Map, discoveredDirs:Set, deliveredSourceIds:Set, pendingDiscovery:Promise}`.
- `Fht(state, repoRoot, cwd)` pre-seeds `discoveredDirs` with repoRoot and every dir from cwd up to repoRoot, so eagerly-loaded dirs are never re-delivered.
- `l6n` realpaths `dirname(filePath)`, **bails if outside repoRoot**, then walks upward collecting `Dht` matches plus `<dir>/.github/instructions/**/*.instructions.md`, stopping at an already-discovered dir or repoRoot.
- `applyTo` frontmatter is matched with minimatch against both the relative path and the basename; `**`, `**/*`, `*` (`A6n`) count as "not specific" and always apply.
- Delivery format (`$ht`) — **full file content**, not a pointer:
  ```
  <system_reminder>
  Custom instructions from {sourcePath}. Apply these to any code you write here:

  {content}
  </system_reminder>
  ```
- It rides on the tool result: `f.newMessages = [...(f.newMessages ?? []), {content: $ht(g), source: "instruction-discovery"}]`.
  `sdk/index.d.ts:10312-10320`:
  > "Source identifier for the hidden follow-up user message that delivers on-demand instruction file discoveries (e.g. nested AGENTS.md). Carried on `ToolResultExpanded.newMessages[].source` so timeline rendering filters it out … and so it is excluded from `originalUserMessages` for compaction purposes."
  ```ts
  declare const INSTRUCTION_DISCOVERY_MESSAGE_SOURCE = "instruction-discovery";
  ```
  ⇒ **On-demand instructions land in the *user-message stream*, not the system prompt**, and are hidden from the UI timeline. A `system.notification` with `kind.type:"instruction_discovered"` is emitted for the UI (`sdk/index.d.ts:29389-29401`).
- IDs: `dynamic-{slug}-{sha256(realPath).slice(0,8)}`; labels get a ` [discovered]` suffix; UI label = `"AGENTS.md from packages/billing/"`.

### Related but distinct: `enableChildInstructions` (staff-only)

`ER()` accepts `{enableChildInstructions}`, wired at `app.js:~723` to `A?.CHILD_CUSTOM_INSTRUCTIONS ?? false`. When granted, it scans cwd to **maxDepth 2** (`J9n=2`, ignoring `node_modules .git vendor dist build .next .nuxt out coverage` = `Y9n`) and emits source `{id:"child-instructions", label:"Child instruction files", type:"child-instructions"}` built by `x.promptsBuildSubdirectoryCustomInstructions(filePaths)` — **paths only, no content**. Similarly `_6n` emits `{id:"nested-agents", label:"Nested AGENTS.md"}` from `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`/`instructionDirectories` roots via `x.repoBuildNestedAgentsInstructionsTable(...)` — again a **table of paths**, a pointer list the model must `view` to expand. Because `CHILD_CUSTOM_INSTRUCTIONS` is `"staff"`, normal users do **not** get the child pointer table.

### ⚠️ Not the same `customInstructions`

`customInstructions` in `CompactionCompleteData:5265`, `HistoryCompactRequest:9281`, `compactHistory(customInstructions?)` `:12250`/`:24238`, `PreCompactHookInput:18913` means **user-supplied focus text for `/compact`** — unrelated to instruction files. Do not conflate.

---

## 4. Does a caller-supplied `systemMessage` suppress instruction assembly?

**Only in `replace` mode. — (b), decisive.**

`sdk/index.d.ts:29224-29230`:
```ts
/**
 * System message configuration for session creation.
 * - Append mode (default): SDK foundation + optional custom content
 * - Replace mode: Full control, caller provides entire system message
 * - Customize mode: Section-level overrides with graceful fallback
 */
declare type SystemMessageConfig = SystemMessageAppendConfig | SystemMessageReplaceConfig | SystemMessageCustomizeConfig;
```
`:29312-29322` — "Replace mode: Use caller-provided system message entirely. **Removes all SDK guardrails including security restrictions.**"

Bundle, `jee()` at `app.js:~723`:
```js
if (d?.mode === "replace") { X?.(void 0); let en = GRt(Y);
    return en ? `${d.content}\n\n${en}` : d.content }
let re = l ? Promise.resolve(undefined)
           : ER(t, true, n, u, {enableChildInstructions: A?.CHILD_CUSTOM_INSTRUCTIONS ?? false, additionalDirs: c})
             .then(en => { let Jn = W?.length ? [...en, ...W.filter(Pr=>!Pr.applyTo)] : en;
                           let cr = I?.size ? Jn.filter(Pr=>!I.has(Pr.id)) : Jn;
                           return Nht(cr) })
```
(`d`=systemMessage, `l`=skipCustomInstructions, `I`=disabledInstructionSources, `W`=additionalInstructionSources, `A`=featureFlags.)

<table>
<thead><tr><th>Mode</th><th>Eager custom instructions in system prompt?</th><th>On-demand discovery still fires?</th></tr></thead>
<tbody>
<tr><td><code>append</code> (default)</td><td>Yes — appended after SDK sections</td><td>Yes (if gate passes)</td></tr>
<tr><td><code>customize</code></td><td>Yes — target section id <code>custom_instructions</code></td><td>Yes</td></tr>
<tr><td><code>replace</code></td><td><b>No</b> — early return short-circuits <code>ER()</code> entirely</td><td>Yes, unless <code>skipCustomInstructions</code> also set (the gate is independent of <code>systemMessage</code>)</td></tr>
</tbody>
</table>

Relevant section ids (`sdk/index.d.ts:29441-29451`):
```ts
declare type SystemPromptSection = "preamble" | "tone" | "tool_efficiency" | "environment_context"
  | "code_change_rules" | "guidelines" | "safety" | "custom_instructions" | "runtime_instructions" | "last_instructions";
```
Doc: "`custom_instructions` targets repository and organization custom instruction sources. `runtime_instructions` targets runtime-provided context … assembled into the CLI prompt's internal `additionalInstructions` slot from sources such as `systemMessage.content`, system notifications, memories, workspace context, mode-specific instructions, and content-exclusion policy."

**Practical takeaway:** if you pass `systemMessage: {mode:"replace", content: myPrompt}` to the SDK, **AGENTS.md / copilot-instructions.md are silently dropped from the system prompt**. Use `append` or `customize` if you want them.

---

## 5. Sub-agents (the `task` tool)

**(b)**, from `SessionAgentExecutor.initializeSession` (`app.js:~796`):

```js
let l = !!this.definition.prompt;
this.session = this.config.createSubagentSession(e, { skipCustomInstructions: l, ... });
...
if (l) { this.session.updateOptions({ systemMessage:{mode:"replace", content: f}, ... }) }
else   { let p = await qRt({...}); this.session.updateOptions({ systemMessage:{mode:"replace", content: p}, ... }) }
```

and `createSubagentSession` (`app.js:~3346`):
```js
enableOnDemandInstructionDiscovery: we?.enableOnDemandInstructionDiscovery ?? this.enableOnDemandInstructionDiscovery, // inherits parent
skipCustomInstructions: we?.skipCustomInstructions ?? false,
skipEmbeddingRetrieval: true,
instructionDirectories / organizationCustomInstructions / disabledInstructionSources: inherited from parent
```

<table>
<thead><tr><th>Sub-agent kind</th><th><code>definition.prompt</code></th><th><code>skipCustomInstructions</code></th><th>Gets custom instructions?</th></tr></thead>
<tbody>
<tr><td>Agents with their own prompt — YAML built-ins (<code>explore</code> etc.), file-based custom agents, plugin/remote agents</td><td>non-empty</td><td><b>true</b></td><td><b>No.</b> Prompt is used verbatim in <code>{mode:"replace"}</code>; <code>ER()</code> never runs.</td></tr>
<tr><td><code>general-purpose</code></td><td>empty/falsy</td><td>false</td><td><b>Yes — re-discovered, not inherited.</b> <code>qRt()</code> (<code>app.js:~725</code>) calls <code>jee({... skipCustomInstructions:false ...})</code> with a fresh capability set, baking freshly-discovered instructions into the generated prompt string, which is then applied via <code>{mode:"replace"}</code>.</td></tr>
</tbody>
</table>

On-demand discovery is **inherited from the parent session** (`?? this.enableOnDemandInstructionDiscovery`) but is still ANDed with the sub-agent's own `skipCustomInstructions` — so prompt-bearing sub-agents get no on-demand discovery either. `skipEmbeddingRetrieval: true` is hardcoded for sub-agents ("they inherit the parent's prompt context", `sdk/index.d.ts:26060-26064`). `disabledInstructionSources` propagates ("Used by sub-agents to respect session-scoped instruction toggles", `sdk/index.d.ts:30604-30608`).

---

## 6. Precedence / merge order

**(a) Official position:** *"Copilot CLI **combines** their instructions. It removes duplicate copies of identical user-level `copilot-instructions.md`, repository-wide, and agent instructions, but **does not define a general precedence order** between these files. Avoid conflicting instructions."* Also, from the CLI concept page: *"All custom instruction files now **combine** instead of using priority-based fallbacks."*

**(b) Code-evidenced push order** in `Z9n()` (`app.js:119`), which is the array order handed to the merger:

1. user-global (`WDe`): `~/.copilot/copilot-instructions.md` (`id:"home-copilot"`), then `~/.copilot/instructions/**/*.instructions.md` (`id:"user-copilot-instructions"`, `type:"vscode"`)
2. repo-root `.github/copilot-instructions.md` (`type:"repo"`)
3. cwd `.github/copilot-instructions.md` (`cwd-` prefixed, `location:"working-directory"`) — only when cwd ≠ repoRoot
4. repo-root model files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
5. cwd model files
6. **inherited** — `Dht` matches in every dir strictly between cwd and repo root (`id:"inherited-*"`)
7. vscode-style `*.instructions.md` from `<root>/.github/instructions/**` for cwd, repoRoot and additional dirs (glob, `nocase:true`; frontmatter `applyTo` / `description` / `excludeAgent`)
8. `nested-agents` pointer table (from `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` / `instructionDirectories` only)
9. `child-instructions` pointer table (staff flag only)

Then, in order:
- `e6n` dedups **model files** by `realpath` OR identical content, merging `sourcePath`s with `" + "`
- a content-hash dedup (`f3`) applied only to types `{"home","repo","model"}`
- an id-uniqueness pass
- `Nht(sources)` → native `x.repoMergeInstructionSources(...)` → `{content, source, sourcePath, additionalInstructions, mergedFromHome}`

**Uncertainty:** the final assembly happens in the compiled native addon (`x.*`), so anything beyond push order is opaque from JS. Combined with the docs explicitly disclaiming a precedence order, **do not rely on ordering to resolve conflicts.**

Filtering applied on top (`jee`): `additionalInstructionSources` without `applyTo` are appended; `disabledInstructionSources` (driven by `/instructions`) filters by source id.

Caching: results are memoized in a `z3` Map, cleared by `G3()`. Docs (a) match: *"Changes you make to custom instructions files are not immediately available for use in active CLI sessions… exit and resume (`copilot --continue`) or `/new`."*

---

## 7. Size / truncation limits

**None found for instruction files** — searched the `.d.ts` and the bundle. What exists is unrelated:
- `maxInlineBinaryBytes` / `DEFAULT_MAX_INLINE_BINARY_BYTES` = 10 MB — applies to **binary tool results** (`sdk/index.d.ts:27114-27115`).
- `SKILL_CHAR_BUDGET` — applies to **skills**, not instructions.

So: instruction files appear to be injected in full, with no documented or code-evident cap. Practical limits are the model context window (`/context` shows the breakdown). Treat "no limit" as *not disproven* rather than *proven*.

Other constants worth noting: `S6n = new Set(["coding-agent","cloud-agent"])` — `excludeAgent` frontmatter values that skip an `.instructions.md`; case-insensitive filesystem handling via `Lht()`/`ab()`/`t6n()` (so `agents.md` may resolve on macOS/Windows).

---

## 8. Version drift warning — (c)

github/copilot-cli **[#3987](https://github.com/github/copilot-cli/issues/3987)** (open, filed 2026-07-01, labels `area:context-memory`, `area:configuration`) reports that as of **1.0.66** an `AGENTS.md` in a `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` directory is **no longer inlined** into the system prompt and is instead registered as a path-scoped "nested" entry, loading only if later read. The reporter attributes the change to the native `repoBuildNestedAgentsInstructionsTable` / `runtime.node` (39.6 MB → 46.5 MB), not the JS bundle — consistent with my finding that final merge logic is native and opaque. **The installed copy here is 1.0.65 (pre-change); the machine's global `copilot` may be newer.**

Related open issues: [#3840](https://github.com/github/copilot-cli/issues/3840) (`/instructions` opt-out not persistent), [#3507](https://github.com/github/copilot-cli/issues/3507) (`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` only half-honored in 1.0.54), [#3051](https://github.com/github/copilot-cli/issues/3051) (recursive subfolder AGENTS.md discovery — **still open**).

---

## 9. Gaps & uncertainties

- **Deliverable:** the requested file was not written — no write tool available.
- **`cliSessionDefaults()` literal never read.** "The CLI sets `enableOnDemandInstructionDiscovery: true`" is inferred from the `.d.ts` prose at `:25989` plus `ON_DEMAND_INSTRUCTIONS` availability `"on"`. Not directly verified.
- **Native merge order opaque** (`x.repoMergeInstructionSources`, Rust/N-API addon).
- **No runtime experiment.** Everything is static analysis + docs. A 5-minute empirical check would settle it: create `sub/AGENTS.md` with a canary string, start `copilot`, run `/context` (canary absent), then `view sub/file.ts`, then `/context` again (canary present).
- **Global install unchecked** (`npm root -g`, `which copilot`) — no shell tool. Version may differ from 1.0.65; see §8.
- **`agents.md` spec site** returned only sample content, no normative statement on nested-file precedence. GitHub's own docs do state it: *"you can create one or more `AGENTS.md` files, stored anywhere within the repository. When Copilot is working, **the nearest `AGENTS.md` file in the directory tree will take precedence**."* — note this is the docs page for *Copilot on GitHub.com / cloud agent*, and its "nearest takes precedence" wording **conflicts** with the CLI page's "all files combine, no defined precedence". Treat the CLI page as authoritative for `copilot`.
- Not read (could add marginal corroboration): `copilot-sdk/types.d.ts`, `copilot-sdk/generated/rpc.d.ts`, `schemas/session-events.schema.json`, `sdk/index.js`.

**Warning for follow-up:** `app.js` is minified with multi-megabyte lines. Broad greps produce enormous output. Grep only with narrow unique literals and small `-C`.