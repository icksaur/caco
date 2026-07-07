# spec-routes-coverage-push

Status: done (2026-07-06). Branch: off master.

## Goals

Raise `src/routes/**` unit coverage (today ~11% statements — the weakest backend
area) by testing the **pure, extractable logic** inside the route handlers, then
lock the gain with a per-directory coverage threshold so it cannot regress. No new
HTTP-integration harness: this is the same "test the route's backing logic directly"
pattern the suite already uses, applied to the untested handlers.

Outcome: `src/routes` statement coverage climbs by a measured, locked-in amount, a
`src/routes/**` threshold block is added to `vitest.config.ts` at the achieved level
minus a small margin, and the whole gate stays green. The win is the **ratcheted
lock at whatever level the targeted logic achieves**, not a fixed percentage — the
route files are ~4800 lines dominated by Express glue that unit tests correctly do
not cover, so a large absolute jump is not expected (see Acceptance).

## Design

**House testing pattern (fact — do not reinvent).** The unit suite never stands up
an Express server. Two existing shapes:
- Import the route's REAL exported backing function and assert on it
  (`sessions-throughput-route.test.ts` imports `snapshot`). ← preferred.
- Duplicate the handler's logic into the test and assert on the copy
  (`mcp-routes.test.ts` re-declares `isPathAllowed`). ← **anti-pattern; forbidden
  here** — it tests a copy that silently drifts from the real code, adding no
  regression protection.

**Mechanism chosen: test-the-real-export, extracting where necessary.** For each
target, either (a) the pure logic is already a named function — export it if needed
and import it in a test; or (b) the pure logic is inline in a `router.get/post`
handler — extract it into a small exported pure helper in the same file, leave the
handler calling it, and test the helper. Chosen over supertest/live-Express because
the suite has no such harness, Express plumbing is not the risk surface (validation/
parse/shape logic is), and extraction also shrinks the untestable handler body — the
same extract-and-test move that already paid off this session (`resolveModelRates`,
`cacheMissCredits`, `resolveResumeSystemMessage`).

**Targets (untested pure logic; already-tested ones excluded).**
`resolveServersTarget` and `validateScheduleInterval` are ALREADY tested — skip them.

- `buildSkillPrompt(name, input)` — `src/routes/sessions.ts:38`. Pure string builder.
  Already a named function (module-private) → export it. Direct test.
- `readGitBranch(cwd)` — `src/routes/sessions.ts:47`. Reads `.git/HEAD`; returns the
  branch after `ref: refs/heads/`, else the first 8 chars (detached), else null on
  missing. Export it. Test via a temp dir with a hand-written `.git/HEAD`.
- `allowLocalhostCors(req, res)` — `src/routes/sessions.ts:56`. Sets CORS headers when
  Origin matches `^https?://localhost(:\d+)?$`; returns true (and 204-ends) on OPTIONS,
  else false. Export it. Test with a minimal fake `req`/`res` (plain objects capturing
  `setHeader`/`status`/`end`).
- `isCardPersist(v)` — `src/routes/file-edits.ts:180`. Pure type-guard for the card
  PUT body. Export it. Direct test with valid/invalid shapes.
- `walkProjectFiles(rootDir, showDotfiles?, respectGitignore?)` — `src/routes/api.ts:504`.
  fs walk. Test against a temp directory tree (dotfile + gitignore toggles).
- `scanPromptDir(dir)` — `src/routes/api.ts:587`. fs scan → Map of `{name,description,
  path}`. Test against a temp dir of prompt files.

**Divisibility.** Two independent slices, shippable in order:
- **Slice A (cheap, pure):** `buildSkillPrompt`, `isCardPersist`, `allowLocalhostCors`
  — no fs, no temp dirs. Do first.
- **Slice B (fs, temp-dir):** `readGitBranch`, `walkProjectFiles`, `scanPromptDir`.
The per-directory threshold lock is added LAST, after measuring the achieved coverage.

## Invariants

- **No logic duplication in tests.** Tests import the real exported function; they
  never re-declare a copy of handler logic (the `mcp-routes` anti-pattern). A test
  that would pass against a stale copy protects nothing.
- **Extraction is behavior-preserving.** Moving inline logic into an exported helper
  must not change the handler's observable behavior; the helper is called from the
  exact former call site. (The existing full suite guards this.)
- **Coverage floors only ratchet up.** The new `src/routes/**` threshold is set at the
  achieved level minus a small churn margin and is never lowered without cause
  (matches the existing ratchet policy comment in `vitest.config.ts`).

## Considerations

- **Temp-dir hygiene.** Slice B tests create/remove temp dirs under `os.tmpdir()`
  (never real paths); use neutral paths so the PII pre-commit hook passes.
- **fake req/res for `allowLocalhostCors`.** Keep it a hand-rolled object literal
  capturing header/status/end calls — no Express, matching house style.
- **`readGitBranch` edge cases** are the oracle-rich part: `ref: refs/heads/<branch>`
  → branch name; a branch with slashes (`ref: refs/heads/feature/foo` → `feature/foo`);
  surrounding whitespace/newline in `HEAD` is trimmed; a raw 40-char SHA (detached HEAD)
  → first 8 chars; missing/unreadable file → null. Hand cases pin all of these.
- **fs-walker oracles must pin an EXACT tree and EXACT sorted output** (not a loose
  "contains" check — a mirrored/weak oracle could pass with a real walker bug). Build a
  known temp tree and assert the exact sorted relative-path set for `walkProjectFiles`
  across each toggle dimension: `showDotfiles` on/off (dotfiles appear/vanish),
  `respectGitignore` on/off with a `.gitignore` holding both a file pattern and a
  directory pattern, always-excluded dirs (e.g. `node_modules`/`.git`), and a
  missing/unreadable subdir (must not throw). For `scanPromptDir`, assert the exact
  `{name,description,path}` map: verify description derivation and any length
  truncation against the REAL function's behavior (read the implementation first;
  pin the actual numbers, do not invent a truncation length), non-prompt files
  excluded, and an empty/missing dir → empty map.
- **Threshold granularity.** Set `src/routes/**` per-metric (stmts/branch/funcs/lines)
  from the measured post-test numbers, not a guessed round figure.
- **Don't chase Express-glue coverage.** `router.get(...)` registration lines and
  `res.json(...)` wiring that need a live server are out of scope — the point is the
  logic, not the framework.

## Risks and Mitigations

- **Over-mocking yields fake signal** → prefer real fs (temp dirs) and real exported
  functions over mocks; only `req`/`res` are faked (they have no pure substitute).
- **Extraction introduces a regression** → keep extractions literal (cut logic, paste
  into exported helper, call it); rely on the full suite + typecheck as the guard.
- **Threshold set too high (flaky gate)** → margin below achieved; verify `npm test`
  green twice before committing.

## Acceptance

- Observable: new test files exist for the six targeted functions and pass. Running
  `npx vitest run --coverage` shows `src/routes` statement coverage measurably higher
  than the 11% baseline (the exact achieved figure is recorded in step C1 — no fixed
  percentage target, since ~4800 lines of route code are mostly Express glue that unit
  tests do not cover; ~238/2123 stmts covered today, and six pure helpers add a bounded
  amount). The coverage run FAILS if `src/routes` later drops below the new threshold.
- Budgets: coverage-run overhead stays ~1s (no new heavy deps; no supertest).
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npm test`
  (coverage-enforced), `npm run build:client`, `npm run check:specs` — all green.
- Oracles: see Plan; each targeted function has a direct oracle (hand case / reference
  / round-trip), failing before its (extraction +) test exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| A1 | Export `buildSkillPrompt`; unit-test it | `src/routes/sessions.ts`, `tests/unit/sessions-route-logic.test.ts` | hand cases: empty input → no trailing space; non-empty → `…with: <input>` | no-dup |
| A2 | Export `isCardPersist`; unit-test valid/invalid card bodies | `src/routes/file-edits.ts`, `tests/unit/file-edits-route-logic.test.ts` | reference: each field rule (missing relativePath → false; wrong-typed optional → false; minimal valid → true) | no-dup |
| A3 | Export `allowLocalhostCors`; test with fake req/res | `src/routes/sessions.ts`, `tests/unit/sessions-route-logic.test.ts` | hand cases: localhost Origin → headers set; non-localhost → not set; OPTIONS → 204 + returns true; GET → returns false | no-dup |
| B1 | Export `readGitBranch`; test via temp `.git/HEAD` | `src/routes/sessions.ts`, `tests/unit/sessions-route-logic.test.ts` | hand cases: `ref: refs/heads/main` → `main`; `ref: refs/heads/feature/foo` → `feature/foo`; whitespace/newline trimmed; 40-char SHA → first 8; missing file → null | no-dup |
| B2 | Export + test `walkProjectFiles` over an exact temp tree | `src/routes/api.ts`, `tests/unit/api-route-logic.test.ts` | reference: exact sorted relative-path set for the pinned tree; dotfiles on/off, gitignore file+dir patterns on/off, always-excluded dirs, missing subdir does not throw | behavior-preserving |
| B3 | Export + test `scanPromptDir` over an exact temp prompt dir | `src/routes/api.ts`, `tests/unit/api-route-logic.test.ts` | reference: exact `{name,description,path}` map; description derivation + real truncation length (read impl first), non-prompt files excluded, empty/missing dir → empty map | behavior-preserving |
| C1 | Measure achieved `src/routes` coverage; add `src/routes/**` threshold block at achieved−margin; record the achieved figure in this row | `vitest.config.ts` | ACHIEVED: src/routes 11.2%→14.9% stmts (branch 6.4→10.8, funcs 11.1→14.7, lines 11.5→14.8); lock set 13/9/13/13; global floor raised 39/34/40/40→40/35/41/41. `npm test` green with the lock | ratchet-up |

## Rationale (skippable)

Coverage work this session established a ratcheting floor and enforced it on
`npm test`. The backend's biggest remaining gap is `src/routes` (11%). The suite's
own convention is to test route logic directly, not over HTTP — so the highest-value,
lowest-risk push is to export/extract the pure validation/parse/shape/build helpers
these handlers already contain and pin them, then lock the directory. This mirrors
the extract-pure-logic pattern that produced this session's most durable tests, and
it deliberately stops at the Express boundary, where unit testing has poor signal.
