# Custom-instruction file loading: measured behaviour

What actually reaches a model's context, per entry point, for `AGENTS.md` and
`copilot-instructions.md`. Measured 2026-08-09.

**Versions.** Originally measured with the `copilot` CLI at 1.0.77/1.0.78 and
Caco's vendored runtime pinned at 1.0.65, which meant the two entry points ran
different code. Caco has since been bumped to `@github/copilot-sdk` 1.0.9 /
runtime **1.0.78**, and the whole matrix was re-run: every result below
reproduces unchanged, including the `customize` sizes and the on-demand
discovery behaviour. Bundle citations were taken from 1.0.65 and re-checked
against 1.0.78, where the `SystemPromptSection` union is identical.

This supersedes the result table in `prompt-discovery.md`, confirms its central
finding (that Caco sessions received nothing), identifies the cause it left
open, and records the fix.

Harness and re-run instructions: `tools/instr-lab/`. Background research and
citations into the SDK bundle: `research-instruction-loading.md`.

## Result

`YES` means the file's content reached the model with no tool call. Every `YES`
below is backed by a trial in which the runtime touched no instruction file —
see *How each cell is proven*.

The Caco column describes Caco **after** the two fixes this investigation
produced (`2fce380`, `9261189`); it was `NO` in every row before them, which is
what prompted the work. The values below are re-measured against the running
server, not inferred from the change.

<table>
<thead>
<tr>
  <th align="left">File</th>
  <th><code>copilot</code> CLI</th>
  <th><code>task</code> general-purpose</th>
  <th><code>task</code> explore</th>
  <th>Caco session / delegate</th>
</tr>
</thead>
<tbody>
<tr>
  <td align="left"><code>~/.copilot/copilot-instructions.md</code></td>
  <td>YES</td><td>YES</td><td>no</td><td>YES</td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/AGENTS.md</code></td>
  <td>YES</td><td>YES</td><td>no</td><td>YES</td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/sub/AGENTS.md</code></td>
  <td>only after a <code>view</code> inside <code>sub/</code></td>
  <td>no</td><td>no</td>
  <td>only after a <code>view</code> inside <code>sub/</code></td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/copilot-instructions.md</code></td>
  <td><b>no</b></td><td>no</td><td>no</td><td><b>no</b></td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/sub/copilot-instructions.md</code></td>
  <td><b>no</b></td><td>no</td><td>no</td><td><b>no</b></td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/.github/copilot-instructions.md</code></td>
  <td>YES</td><td>YES</td><td>no</td><td>YES</td>
</tr>
<tr>
  <td align="left"><code>&lt;root&gt;/sub/.github/copilot-instructions.md</code></td>
  <td>only after a <code>view</code> inside <code>sub/</code></td>
  <td>no</td><td>no</td>
  <td>only after a <code>view</code> inside <code>sub/</code></td>
</tr>
</tbody>
</table>

Caco now matches the CLI in every row. Two results still contradict a reasonable
expectation, and both are properties of the runtime rather than of Caco:

- **A project-root `copilot-instructions.md` is never loaded by anything.** Only
  `.github/copilot-instructions.md` is a real location. A bare root-level file
  is invisible to every entry point. The runtime's convention table registers
  that filename exclusively under a `.github` directory, and the official
  documentation corroborates by omission: the only two `copilot-instructions.md`
  locations it lists are `.github/copilot-instructions.md` and
  `$HOME/.copilot/copilot-instructions.md`.
- **A subdirectory `copilot-instructions.md` is not loaded either** — but
  `sub/.github/copilot-instructions.md` *is*, on demand. The subdirectory walk
  applies the same `.github` convention, so the nested file only counts when it
  keeps the convention directory.

## Why Caco sessions received nothing, and what fixed it

Caco **used to** pass `systemMessage: { mode: 'replace', ... }`. `replace`
discards the SDK's assembled system prompt, and the assembled prompt is where
the `custom_instructions` section lives, so replacing the prompt deleted every
custom-instruction source as a side effect. The intent was only ever "use my
prose instead of the SDK's"; the loss of the user's rules was collateral, and
silent in both directions — a session could not tell it had loaded nothing, and
neither could its caller.

**Fixed in `2fce380`**: `toSdkSystemMessage` (`src/prompts.ts`) translates that
intent into `mode: 'customize'` at the SDK boundary, overriding every SDK prose
section by name while never mentioning `custom_instructions` — unmentioned
sections are preserved, which is the whole mechanism. **`9261189`** then set
`enableOnDemandInstructionDiscovery` on both the create and resume paths, which
is what earns Caco the subdirectory rows; the SDK defaults it off and the CLI
opts in.

The order matters: on-demand discovery cannot fire while the assembled prompt is
being discarded, so the second fix is inert without the first. That is measured,
not assumed — see the `replace` + on-demand row below.

Proven by single-variable bisect against the raw SDK, same fixture, same model,
one field changed at a time (`tools/instr-lab/run-sdk.mjs`). This bisect runs
in-process on the *same* vendored runtime Caco itself uses, so the result is a
property of the option rather than of a version difference. It was run on both
1.0.65 and 1.0.78 with identical outcomes:

<table>
<thead><tr><th align="left">Session options</th><th>global</th><th>root <code>AGENTS.md</code></th><th><code>.github/copilot-instructions.md</code></th></tr></thead>
<tbody>
<tr><td align="left">no <code>systemMessage</code></td><td>loaded</td><td>loaded</td><td>loaded</td></tr>
<tr><td align="left"><code>mode: 'append'</code></td><td>loaded</td><td>loaded</td><td>loaded</td></tr>
<tr><td align="left"><code>mode: 'replace'</code> ← Caco</td><td><b>gone</b></td><td><b>gone</b></td><td><b>gone</b></td></tr>
<tr><td align="left"><code>mode: 'replace'</code> + on-demand discovery on</td><td><b>gone</b></td><td><b>gone</b></td><td><b>gone</b></td></tr>
</tbody>
</table>

The last row matters: enabling on-demand discovery does **not** compensate.
Whatever `replace` removes stays removed.

Two candidate causes were tested and ruled out, and both remain as live variants
in `run-sdk.mjs` so the claim stays reproducible: the shared client being rooted
at the server's cwd rather than the session's (`client-rooted-elsewhere`), and
`streaming: true`. Both load instructions normally. The SDK also offers a third
mode, `customize`, which overrides named prompt sections while keeping the rest
of the structure — the obvious escape hatch if Caco wants its own prompt *and*
the user's rules.

One trap is worth recording, because it produced a confident wrong answer
before it was caught. `systemMessage` takes a `SystemMessageConfig` object; a
plain string is accepted and **silently ignored**. An early bisect passed
strings, so every variant was secretly identical and the run appeared to
exonerate `systemMessage`. The harness now reads back the recorded
`system.message` from the session's event log and reports `sysmsg:applied` or
`sysmsg:IGNORED` per variant, so a no-op variant can never again be read as
evidence.

An important consequence, and the reason this was worth chasing: Caco is where
the standing reviewer and delegate sessions live, so until these fixes those
sessions ran on model priors instead of the operator's rules — including the
instruction that a reviewer never modifies files, and the commit-message policy.
Every review delegated before `2fce380` was produced without them.

### Verified after the fix, against the running server

The table's Caco column is re-measured, not inferred. Three trials through the
live server on the shipped code:

<table>
<thead><tr><th align="left">Trial</th><th>global</th><th><code>AGENTS.md</code></th><th><code>.github/…</code></th><th><code>sub/AGENTS.md</code></th></tr></thead>
<tbody>
<tr><td align="left">no tools at all</td><td>LOADED</td><td>LOADED</td><td>LOADED</td><td>absent</td></tr>
<tr><td align="left">edits <code>sub/</code>, agent chose <code>edit</code></td><td>LOADED</td><td>LOADED</td><td>LOADED</td><td>absent</td></tr>
<tr><td align="left">edits <code>sub/</code>, <code>view</code> forced</td><td>LOADED</td><td>LOADED</td><td>LOADED</td><td><b>LOADED</b></td></tr>
</tbody>
</table>

The first row is the strongest: tools were removed entirely, so injection is the
only possible source. The last two are the same fixture and differ only in
whether a `view` happened — and the runtime's own event names what it did:

```
runtime_discovery_events: sub/AGENTS.md (trigger: view on target.txt)
```

The middle row is worth keeping rather than discarding as a failed trial. Left
to itself the agent reached for `caco_run_workflow` and `edit` and never issued
a `view`, so the nested file never arrived. That is not a Caco defect — it is
the tool-choice dependency described above, and Caco's richer tool surface makes
it *more* likely than in the CLI, not less.

## A long-lived client serves stale instruction files

The runtime memoises instruction-file **content** per directory for the life of
the process. A brand-new session in an old process still gets the old file.

Measured (`tools/instr-lab/cache-test.sh`), rewriting `AGENTS.md` between reads:

```
on disk, generation 1: BRAVO=567ad678c351597223d27d8bbd355c64
caco sub-agent, before edit : 567ad678c351597223d27d8bbd355c64
on disk, generation 2: BRAVO=23740c6df2b97f75b3d4eae920d5dfd8
fresh copilot process      : 23740c6df2b97f75b3d4eae920d5dfd8   <- ground truth
caco sub-agent, after edit : 567ad678c351597223d27d8bbd355c64   <- stale
```

The load-bearing comparison is the first and last lines: the *same* long-lived
process read generation 1 correctly, then kept serving it after the file
changed. The middle leg runs in a separate, freshly started process and exists
only to prove the write reached disk.

So for any long-running host — Caco's shared SDK client, or an interactive
`copilot` session — **editing `AGENTS.md` does not affect anything until the
process restarts.** Creating a new session is not enough. This is the mechanism
behind `prompt-discovery.md`'s observation that the probing session's copy was
"stale": it is not refreshed on new sessions, only on a new process.

## On-demand discovery, and why two models disagreed

Subdirectory instructions arrive through a distinct mechanism from eager
loading. The runtime hooks file access and, on a successful **`view`**, walks up
from the file's directory and injects any instruction files it finds. It
announces this as a first-class event, which makes it directly observable
rather than inferred:

```json
{"type":"system.notification","data":{"content":"Discovered instruction: sub/AGENTS.md",
 "kind":{"type":"instruction_discovered","sourcePath":"sub/AGENTS.md",
 "triggerFile":".../sub/target.txt","triggerTool":"view","description":"AGENTS.md from sub/"}}}
```

Only `view` triggers it. In the same trial with the same prompt, Sonnet used
`view` then `edit` and received `sub/AGENTS.md`; Terra used `apply_patch`, never
issued a `view`, and received nothing. **Which subdirectory instructions a model
sees therefore depends on which editing tool it happens to prefer** — a silent,
model-dependent difference in the rules an agent is following.

Three conditions must all hold for on-demand discovery to fire:
`enableOnDemandInstructionDiscovery` (SDK default **false**; the CLI opts in),
`skipCustomInstructions` false, and the `ON_DEMAND_INSTRUCTIONS` feature flag
(granted broadly). Caco sets the first as of `9261189`, on both the create and
the resume path — the SDK does not persist the option, so a resume that omitted
it would leave a resumed session quietly behaving differently from a fresh one
in the same directory.

Eager loading covers the git root, the cwd, and directories *between* them —
measured, see *The ancestor walk* below. Descendants of cwd are never eagerly
loaded; recursive subfolder discovery is gated behind a staff-only flag.

## The fix, validated

`customize` mode overrides named prompt sections instead of discarding the
prompt. The sections are `preamble`, `tone`, `tool_efficiency`,
`environment_context`, `code_change_rules`, `guidelines`, `safety`,
`custom_instructions`, `runtime_instructions`, `last_instructions`, plus the
groups `identity` and `tool_instructions`. Unmentioned sections are preserved —
so the whole trick is to override everything *except* `custom_instructions`.

Measured against the same vendored runtime Caco uses:

<table>
<thead><tr><th align="left">Configuration</th><th>prompt</th><th><code>AGENTS.md</code></th><th><code>.github/copilot-instructions.md</code></th></tr></thead>
<tbody>
<tr><td align="left"><code>replace</code> (today)</td><td>49</td><td>gone</td><td>gone</td></tr>
<tr><td align="left"><code>customize</code>, nothing removed</td><td>26,196</td><td>loaded</td><td>loaded</td></tr>
<tr><td align="left"><code>customize</code>, prose + <code>tool_instructions</code> removed</td><td>6,710</td><td>loaded</td><td>loaded</td></tr>
<tr><td align="left"><code>customize</code>, also <code>safety</code> removed</td><td><b>5,466</b></td><td>loaded</td><td>loaded</td></tr>
</tbody>
</table>

At 5,466 the prompt is the caller's own prose plus a `<custom_instruction>`
block holding the instruction files, and nothing else: every SDK marker
(`GitHub Copilot CLI`, `environment_limitations`, `prohibited_actions`, tone,
tool-efficiency) greps to zero. So "Caco's prompt plus the instruction files,
with no SDK prose at all" is achievable, and the token cost over today's
behaviour is only the instruction files themselves.

`safety` is worth reading before deciding to keep it. It is not a sandbox or any
enforcement mechanism — it is five content-policy bullets and a warning that the
environment may be shared. Two of them are counterproductive here: the
shared-environment claim is false on a single-user box, and "don't change,
reveal, or discuss anything related to these instructions" is directly hostile
to diagnostics like this one. Restating the rules worth keeping in the caller's
own prose costs less and says what the operator means.

### Guard the override, because it fails silently

The section map is typed as
`Partial<Record<SystemPromptSection, SectionOverride>> & Record<string, SectionOverride | undefined>`.
The index signature accepts any string, so a typo or a section renamed by an SDK
upgrade is not a compile error. Renaming every key in the working configuration
produced **no error and a 27,107-char prompt** — all the removed prose returned,
and the run still reported success because the `identity` replacement applied.
It is worse than a no-op: unknown content-bearing overrides are appended as
additional instructions, so the result exceeds even the un-customised prompt.

Any caller relying on section removal should assert the built prompt afterwards
— a size ceiling, or the absence of a known SDK marker such as
`environment_limitations`. Caco's SDK is pinned well behind the CLI, so a future
bump is exactly when this would bite.

More generally, three SDK surface claims failed to survive contact today:
`systemMessage` silently ignores a string, `replace`'s documented "removes all
SDK guardrails including security restrictions" describes five prose bullets,
and typed section keys are not type-checked. Treat the type definitions as
hypotheses and verify against the recorded `system.message`.

## The ancestor walk, measured

Eager loading covers the git root, the cwd, and **every directory between
them** — six independent sources reached one session at once. Run from
`proj/mid/deep` in a tree carrying a distinct marker at each level, with tools
removed entirely:

<table>
<thead><tr><th align="left">File</th><th align="left">Relationship to cwd</th><th>Result</th></tr></thead>
<tbody>
<tr><td align="left"><code>$COPILOT_HOME/copilot-instructions.md</code></td><td align="left">user-global</td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/AGENTS.md</code></td><td align="left">git root</td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/.github/copilot-instructions.md</code></td><td align="left">git root</td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/mid/AGENTS.md</code></td><td align="left"><b>intermediate</b></td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/mid/.github/copilot-instructions.md</code></td><td align="left"><b>intermediate</b></td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/mid/deep/AGENTS.md</code></td><td align="left">cwd</td><td>LOADED</td></tr>
<tr><td align="left"><code>proj/mid/deep/sub/AGENTS.md</code></td><td align="left"><b>descendant</b></td><td><b>absent</b></td></tr>
<tr><td align="left"><code>proj/NOTES.md</code></td><td align="left">decoy, no convention</td><td>absent</td></tr>
</tbody>
</table>

Both models agree on every row. The `.github` convention holds at every level:
an intermediate `copilot-instructions.md` loads only inside a `.github`
directory, exactly as at the root.

The asymmetry is the point. **Upward is eager and unconditional; downward is
lazy and conditional.** A descendant `AGENTS.md` is invisible at session start
and arrives only if the model happens to `view` a file in that subtree. So a
rule that must always apply belongs at or above the cwd, never below it.

This section exists because the rest of this document originally asserted the
ancestor walk from documentation and bundle reading without measuring it — the
main matrix always ran with cwd at the repo root, so the intermediate case was
never exercised. `tools/instr-lab/depth-test.sh` reproduces it.

## Descendant instruction files

No descendant file is *ever* eagerly loaded, under any convention. With tools
removed entirely and the cwd at `proj/mid/deep`:

<table>
<thead><tr><th align="left">File below the cwd</th><th>eager (no tools)</th><th>after a <code>view</code> in <code>sub/</code></th></tr></thead>
<tbody>
<tr><td align="left"><code>sub/AGENTS.md</code></td><td>absent</td><td><b>LOADED</b></td></tr>
<tr><td align="left"><code>sub/.github/copilot-instructions.md</code></td><td>absent</td><td><b>LOADED</b></td></tr>
<tr><td align="left"><code>sub/copilot-instructions.md</code> (bare)</td><td>absent</td><td><b>absent</b></td></tr>
</tbody>
</table>

So the answer differs by convention:

- **`sub/.github/copilot-instructions.md` is reachable** — but only on demand.
  The `.github` requirement applies to descendants exactly as it does at the
  root, so the convention is consistent all the way down.
- **A bare `sub/copilot-instructions.md` is reachable by nothing.** It is not
  eagerly loaded, and the on-demand walk skips it too, because that walk applies
  the same `(filename, convention directory)` table. There is no depth at which
  a bare `copilot-instructions.md` works.

The runtime names what it loaded, so this is observed rather than inferred. A
single `view` of one ordinary source file loaded *both* instruction files in
that directory, 9ms apart, with the same `triggerFile` and `triggerTool`:

```
22:43:31.347  TOOL  bash   echo "edited" >> .../sub/target.txt     <- no discovery
22:43:33.631  TOOL  view   .../sub/target.txt
22:43:33.640  DISCOVER  sub/.github/copilot-instructions.md  (trigger: view on target.txt)
22:43:33.641  DISCOVER  sub/AGENTS.md                        (trigger: view on target.txt)
```

Three things follow from that timeline. The walk loads **every** convention
match in the directory, not just the nearest or first. The two events are
chained (the second's `parentId` is the first's `id`), so they are one emission
rather than two independent walks. And the bare `sub/copilot-instructions.md`
sat in the same directory throughout and was not among them.

The run also contains an unplanned control: the agent first modified that exact
file with `bash`, and no discovery fired. Two seconds later it `view`ed the same
file and both loaded. Same file, same directory, same session — the only
variable is the tool.

### The trigger is the model's tool choice, not the file

Only `view` fires the walk. Writing to a file does not: in the timeline above,
`bash` appended to `sub/target.txt` with no effect, and the same file `view`ed
two seconds later loaded both instruction files. The SDK's own type comment
agrees, describing `triggerTool` as "currently always 'view'".

In the same arm with the same prompt and fixture, Sonnet called `view` and
received both descendant files; Terra used only `apply_patch`, never issued a
`view`, and received neither — its transcript contains no discovery events at
all. Confirmed from the recorded `toolName` of every tool call in both runs.

This is the sharpest practical consequence in this document: **whether a
subdirectory's rules apply depends on which editing tool the model happens to
prefer.** Two models, same repo, same task, different governing instructions,
with nothing in either transcript announcing the difference.

### The walk does not leave the cwd tree

On-demand discovery is bounded by the session's working directory. A `view` of a
file in a *different* tree loads nothing from that tree — not the viewed file's
own directory, and not that tree's repo root.

Measured with both views in a **single session**, so the mechanism cannot be
blamed for being inert and the model cannot be blamed for not viewing:

```
22:54:11.974  view  neutral/own/mine.txt        (inside the cwd tree)
22:54:11.975  view  peer/deep/target.txt        (a separate git repo)

DISCOVER  own/AGENTS.md  (trigger: view on mine.txt)
                         ... and nothing else
```

<table>
<thead><tr><th align="left">File</th><th align="left">Relationship</th><th>Result</th></tr></thead>
<tbody>
<tr><td align="left"><code>own/AGENTS.md</code></td><td align="left">inside the cwd tree</td><td><b>LOADED</b></td></tr>
<tr><td align="left"><code>peer/deep/AGENTS.md</code></td><td align="left">viewed file's own directory</td><td>absent</td></tr>
<tr><td align="left"><code>peer/deep/.github/copilot-instructions.md</code></td><td align="left">viewed file's own directory</td><td>absent</td></tr>
<tr><td align="left"><code>peer/AGENTS.md</code></td><td align="left">foreign repo root</td><td>absent</td></tr>
<tr><td align="left"><code>peer/.github/copilot-instructions.md</code></td><td align="left">foreign repo root</td><td>absent</td></tr>
</tbody>
</table>

Both `view` calls succeeded — the peer view returned the file's real contents —
and they are one millisecond apart in the same turn. The only difference is
which tree the file was in. The user-global instructions file still loaded, as
it is not tree-scoped.

A second arm confirms the same result when the cwd is not a git repository at
all: the out-of-tree view produces no discovery events either way, so the
boundary is the working directory rather than a git root.

This closes a plausible worry: an agent reading a peer checkout does **not**
silently absorb that project's rules. It also means the reverse — pointing a
session at one directory and asking it to work in another gives you no
instructions from the tree you are actually editing.

## How each cell is proven

The question is not what a model says, but whether it could have gotten the
answer another way. Four independent guards:

1. **Unguessable markers.** Each location holds one random 128-bit hex value,
   regenerated per run. Names are neutral (`ALPHA`…`HOTEL`), so a model cannot
   infer which file a marker lives in and produce a plausible guess.
2. **A confabulation control.** `GOLF` exists in no file. Any answer other than
   `ABSENT` invalidates the whole trial. This caught a real failure: a model
   with no instructions invents rather than abstains.
3. **A tool-use decoy.** `HOTEL` sits in `NOTES.md`, which no convention ever
   loads. Reporting `HOTEL` proves the runtime searched the filesystem, so every
   other positive answer becomes unprovable.
4. **Transcript inspection.** Trials run with `--output-format json`; the scorer
   fails any trial whose tool arguments mention an instruction file. The CLI
   `notools` arm goes further and removes tools entirely with
   `--available-tools=`, so injection is the only possible source.
5. **Sub-agent tool tracing.** A `task` sub-agent gets no event log of its own,
   which initially looked like an unavoidable gap. It is not: the sub-agent's
   tool calls still raise `preToolUse` hooks carrying *its* session id, distinct
   from the parent's. The scorer reports every tool called under a non-parent
   session id and marks the trial inconclusive if there are any. The `task` rows
   above were measured with `subagent_tools_called: none`, so they are proven
   the same way the others are, not merely corroborated.

   The trace also reveals something the results table cannot: the
   `general-purpose` sub-agent ran on `gpt-5.4`, not the parent's model. Sub-agent
   instruction loading is therefore independent of the model you selected.

A trial is reported `CONCLUSIVE` only when all five hold. `REFUSED`,
`INCOMPLETE`, and `INVALID` are kept distinct so a model-policy artifact is
never read as evidence about the loader.

Marker extraction is deliberately tolerant of bullets, bold, code fences, and
wrapped lines. A strict line-anchored parser would score a loaded marker as
absent, and understating what a runtime receives is the dangerous direction of
error here.

Both Sonnet and Terra were run through every scenario and agree on every cell
they both answered conclusively. Two Terra trials were discarded by the guards
rather than by judgement: as a `task` parent it declines to relay marker codes,
and in one no-tools run it pasted a single value into all eight slots, which the
`GOLF` control caught. Terra's tool-enabled runs agree with Sonnet throughout,
so no cell rests on a discarded trial.

The global-file scenario runs under `COPILOT_HOME` pointed at a throwaway
directory, so the operator's real `~/.copilot` is untouched. Caco does not
honour `COPILOT_HOME`, so its trials need the real file. That path is opt-in
(`INSTRLAB_GLOBAL=1`) and writes a delimited block which is removed by matching
its delimiters, never by restoring a whole-file backup — a backup restore would
silently discard any edit made to that shared file while the trial ran. An
orphaned block left by a killed run is swept on the next start, so residue is
self-healing.

## Practical consequences

- **Put repository rules in `AGENTS.md` or `.github/copilot-instructions.md`.**
  A root `copilot-instructions.md` is read by nothing.
- **Rules must live at or above the working directory.** Everything from the cwd
  up to the git root loads eagerly and unconditionally; anything below the cwd
  loads only if the model happens to `view` a file there. A bare
  `copilot-instructions.md` below the cwd is loaded by nothing at all.
- **Point the session at the tree you intend to edit.** Discovery never leaves
  the cwd tree, so a session working on files elsewhere gets none of that
  project's rules — and conversely, reading a peer checkout does not import its
  rules into your session.
- **Restart the host process after editing an instruction file.** For Caco that
  means restarting the server; a new session will not pick up the change.
- **Do not rely on subdirectory instruction files.** They reach the model only
  if it happens to `view` a file in that directory, which depends on the model's
  tool choice — and in Caco that dependency is stronger, because an agent with
  `caco_run_workflow` and `edit` may never issue a `view` at all. Measured: an
  unforced Caco run edited the file without viewing it and received nothing;
  the same fixture with a `view` received both nested files. Anything that must
  always apply belongs at the root.
- **Caco guidance can now live in `AGENTS.md`.** Before `2fce380` moving it out
  of the system prompt would have silently dropped it for every Caco session;
  `customize` mode preserves `custom_instructions`, so a repo's `AGENTS.md` and
  Caco's own prose now both reach the model. See *The fix, validated* for the
  measured prompt sizes.
- **`explore` sub-agents get no instructions at all.** Give them their rules in
  the prompt.
- **Caco and the CLI can drift apart.** The CLI auto-updates; Caco's vendored
  copy is pinned and launched with `--no-auto-update`. They are aligned at
  1.0.78 today, but behaviour verified in one is not automatically true of the
  other — re-run this harness after bumping the vendored SDK. `customize` mode
  is itself a recent addition, so the section list is a moving target.

## Re-running

```sh
tools/instr-lab/run-all.sh              # full matrix, both models
tools/instr-lab/depth-test.sh           # eager ancestor walk from a deep cwd
tools/instr-lab/descendant-test.sh <lab> <model> eager|ondemand
tools/instr-lab/outside-cwd-test.sh <lab> <model> neutral|paired
tools/instr-lab/cache-test.sh           # stale-instruction-cache check
node tools/instr-lab/run-sdk.mjs <lab> <model>   # systemMessage mode bisect
INSTRLAB_MODELS="claude-sonnet-4.6 gpt-5.6-terra" tools/instr-lab/run-all.sh
INSTRLAB_GLOBAL=1 tools/instr-lab/run-all.sh     # also test the real global file
```

`mklab.sh` builds the fixture; `verdict.sh` scores one transcript and can be
pointed at any saved `.jsonl`. Results land in `<lab>/results/report.txt`.

Two cautions when re-running. Because of the caching described above, a fixture
directory the host process has already seen will keep serving its first
generation — always point a Caco trial at a **fresh** directory, or restart the
server. And `run-all.sh` regenerates markers, so a transcript must be scored
against the `tokens.env` of its own run; a mismatch shows up as
`STALE-OR-WRONG` rather than as a silent pass.
