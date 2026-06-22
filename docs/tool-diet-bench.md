# Tool-diet benchmark

Fixed tasks run **before and after** each diet change. Each completed request
appends a row to `~/.caco/metrics/requests.jsonl`. To compare before/after,
snapshot or clear the log between the two runs (e.g. rename it after the "before"
pass). Compare the **same task** across runs — comparing different work is too
noisy to be an oracle.

## Protocol

1. Run the build you want to measure (the running server's code is what's recorded).
2. In a fresh session, send each benchmark prompt below verbatim, one per request.
3. Let it run to idle (one prompt = one request = one row).
4. Snapshot the log (`mv requests.jsonl before.jsonl`), make the diet change,
   rebuild/restart, repeat the same prompts.
5. Run the report: `node scripts/bench-report.mjs` (aggregate averages over the
   current log).

## Metrics captured per request

`requestTurns` (model round trips — the headline), `requestReasoning` (reasoning
tokens — dominant latency term), `requestToolCalls` / `requestToolFailures`,
`requestWallMs` (wall-clock to idle), `requestIn`/`requestCache`/`requestOut`,
`requestWorkflowCodeBytes`.

The oracle: for the same prompt, a good diet change lowers turns and/or total
result bytes without raising failures.

## Benchmark prompts (fixed — do not edit casually)

| ID | Prompt | Exercises |
|---|---|---|
| B1-fanout-search | "Which source files under `src/` import from `./session-throughput.js`? List the file paths only." | independent fan-out reads (the workflow sweet spot) |
| B2-count-aggregate | "Count how many `defineTool(` calls exist in each file under `src/`, and report the total." | read + aggregate across many files |
| B3-single-read | "Show me the `recordUsage` function in `src/session-throughput.ts`." | a single targeted read (must NOT regress under a facade blacklist) |
| B4-multi-edit | "Rename the local variable `entry` to `t` inside the `recordRateLimit` function only, in `src/session-throughput.ts`." | a precise single edit (edit-path baseline) |
| B5-explore | "Explain how a request's wall-clock time is measured end to end." | dependent/exploratory reads (round trips are genuine work here) |

Keep this list stable; changing a prompt invalidates its before/after history.
