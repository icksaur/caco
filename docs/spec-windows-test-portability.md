# Spec: Windows Test Portability & Path-Separator Correctness

## Status
Draft — pending gpt-5.3-codex review, then implementation on branch `windows-fixes`.

## Overview

The unit suite passes on Linux but fails on Windows: **23 tests / 10 files**
fail when run via `vitest run` on `win32`. None are logic regressions in the
feature under test. Every failure traces to one of two portability defects:

1. **Path-separator leakage** — production code emits native Windows `\`
   separators where a POSIX `/` is expected (by the frontend, by npm libraries
   like `ignore`, by `jiti`, and by tests). Caco already has a `toPosix()`
   helper (`src/path-utils.ts`) and applies it consistently in the workflow
   facade (`src/workflow/cores.ts`) and index layer (`src/index/*`). Several
   older emit points predate that convention and were never normalized.

2. **POSIX-only assumptions in tests/harnesses** — a hardcoded `/tmp` allowed
   base, in-memory fs-mock keys built from hardcoded `/`-paths, and temp-dir
   teardown that trips Windows file-locking / long-path (`\\?\`) `EPERM`.

This spec catalogs every failure, its root cause, the fix, and the risk. It
separates **genuine cross-platform product bugs** (which affect real Windows
users, not just CI) from **test-portability fixes**.

## Goals

- Green `vitest run` on Windows (0 platform-specific failures), Linux unchanged.
- Fix the underlying **product** bugs, not just silence the tests:
  - `.gitignore` filtering silently broken on Windows (walkProjectFiles).
  - Extension loading path fed to `jiti` uses `\` on Windows.
  - MCP file routes reject the real OS temp dir on Windows (`/tmp` hardcode).
  - Attachment `displayName` extraction mis-handles `\`-paths.
- Keep every emit point consistent with the established `toPosix()` convention.

## Non-Goals

- No change to the security model of `validatePath` (POSIX input already
  round-trips correctly on Windows per its doc comment).
- No broad refactor of path handling beyond the identified emit points.
- No new lint rule to enforce `toPosix` (possible follow-up, out of scope).

## Failure Catalog

### Category A — Genuine cross-platform product bugs

| # | File:Line | Symptom | Root cause | Fix |
|---|-----------|---------|-----------|-----|
| A1 | `src/routes/api.ts:533` | `walkProjectFiles` returns `sub\c.ts`; tests expect `sub/c.ts` | `relative(rootDir, fullPath)` emits `\`; pushed raw. **Also** passed to `ig.ignores(relPath)` — the `ignore` lib requires POSIX separators, so **.gitignore matching is silently broken on Windows** | `const relPath = toPosix(relative(rootDir, fullPath))` before the `ignores()` checks and the `files.push` |
| A2 | `src/extension-runtime.ts:136` | Extensions load 0 tools; `getMetadata` empty | `jiti.import(join(ext.dir,'server.ts'))` produces `\`-path; jiti resolution + the test's module map are POSIX-keyed | `jiti.import(toPosix(join(ext.dir, 'server.ts')))` |
| A3 | `src/dev-docs-tool.ts` — index/`scanDocs` emit (~lines 202,204,264,266) **and doc-body header** ``# ${path}`` (lines 242, 246) | `caco_docs section="index"` lists `docs\spec-...`; a doc fetched by recursive-basename fallback renders header `# C:\...\docs\spec-...`; tests expect `docs/spec-...` | Emits `join(projectRoot,f)` / recursive `full` / the matched candidate `path` with `\` | `toPosix(...)` on each emitted doc path **and** on the `# ${path}` header value |
| A4 | `src/applet-store.ts` (`resolveAppletAsset` return) | Asset path `applets\files\content.html`; test regex expects `/applets/files/...` | Returned resolved path keeps `\` | `toPosix(...)` the returned asset path |
| A5 | `src/browser-tools.ts` (screenshot path return) | Path `.test-browser-...\sess-...`; test expects `.test-browser-screenshots/sess-...` | Returned screenshot path keeps `\` | `toPosix(...)` the returned path (model-facing) |
| A6 | `src/session-auto-repair.ts:125` | `att.path.split('/').pop()` returns whole path for `\`-paths | Splits on `/` only | `att.path.split(/[\\/]/).pop()` |
| A7 | `src/routes/workspace-api.ts:31-34` | `read_file`/`write_file`/`list_directory` return 403 for real temp files on Windows | `ALLOWED_BASES` hardcodes `'/tmp'`; on Windows the OS temp dir (`os.tmpdir()`) is elsewhere, so MCP file ops on temp paths are rejected | Add `tmpdir()` (from `os`) to `ALLOWED_BASES`; keep `/tmp` for Linux |
| A9 | `src/extension-store.ts:104` **and `src/watch-store.ts:148`** | **Whole Caco server crashes when unit tests run.** Raw `fs.watch(...)` with **no `'error'` handler**; the surrounding `try/catch` only guards synchronous construction, not async `'error'` events. On Windows `fs.watch` emits an EPERM `'error'` when a watched dir/file is deleted/renamed/churned → unhandled `'error'` on an EventEmitter → **uncaughtException → process death**. extension-store watches `<cwd>/.caco/extensions` + `~/.caco/extensions`; watch-store backs the files-applet edit leases. | Attach `watcher.on('error', e => { log type only; close })` at BOTH sites so a watch error can never crash the server. Degrade to no-watch for that path (extension-store: reloads on next scan; watch-store: drop the path entry, lease expires). |
| A8 | `src/file-watcher.ts` `buildIgnoredPredicate` | `.gitignore` + excluded-dir rules silently ignored by the file watcher on Windows (test: "honors hardcoded excluded directories and .gitignore rules") | chokidar can report `absPath` with `/` separators on Windows while `repoRoot` (from `process.cwd()`/`join`) is `\`, so `absPath.startsWith(repoRoot)` never matches → the predicate returns "not ignored" for everything. The `ignore` lib also requires POSIX. | Normalize BOTH `absPath` and `repoRoot` to POSIX up front, then derive `rel` / split / `ig.ignores(rel)` in one separator form. (A minimal `toPosix` on just the `ig.ignores` arg is insufficient — the `startsWith` gate fails first.) |

Note A3/A4/A5: these paths are **model-facing** or **frontend-facing**. The
frontend and the agent expect `/` on all platforms (matching ripgrep/glob
output). Emitting `\` is a correctness bug even where no test currently covers
it end-to-end.

### Category B — Test-portability fixes (no product change)

| # | File | Symptom | Root cause | Fix |
|---|------|---------|-----------|-----|
| B1 | `tests/unit/session-auto-repair-more.test.ts` | 4 tests: repair returns `null` | fs-mock keys are hardcoded `/virtual-caco-home/...`; prod builds the path with `path.join`, which yields `\` on Windows → `existsSync` miss | Build the mock key with `join()` (or normalize separators inside the `files` Map lookups) so it matches prod on every platform |
| B2 | `tests/unit/api-route-harness.test.ts` (`rmSync` at :198), `tests/unit/schedule-route-harness.test.ts` (`rmSync` at :42,:46) | Whole file errors: `EPERM ... \\?\C:\...` on cleanup | `rmSync(dir, {recursive,force})` races Windows file-locking / long-path on teardown (reproduced for api-route-harness; schedule shares the pattern — fix both) | Add `maxRetries` + `retryDelay` to the `rmSync` calls (and/or wrap in best-effort try/catch); leftover temp dirs also need `.gitignore` coverage |
| B3 | api-route-harness, output-store, surface-tools, file-watcher-more, git-edit-poller-more, terminal-manager-more, **applet-store-more, extension-store-more, mcp-config-loader, browser-tools** (all created temp trees/files under `process.cwd()`/`originalCwd`) | These harnesses create their temp trees **inside the repo root**. The **live server watches the repo root** (chokidar file-watcher + git-edit-poller on the session cwd, plus the raw extension watcher on `.caco`). Every test run floods those watchers with create/delete storms and force-deletes watched dirs → the A9 crash + a `git diff` subprocess storm. Orphan `.api-route-harness-*` dirs in the repo confirm it. | Create every harness root under `os.tmpdir()` instead of the repo root (import `tmpdir` where usable; in `vi.hoisted` blocks, which run before imports, derive from `process.env.TEMP\|TMPDIR\|/tmp`). Tests `chdir`/`CACO_HOME`/mock `homedir` into their own temp trees, so no dependency on the repo-root location. Removes all test churn from the watched repo. |

B2 is teardown-only; the assertions themselves pass. The `EPERM` throws in
`afterAll`/`beforeEach` mark the whole file failed. (An orphaned
`.api-route-harness-*` dir was observed in the working tree after a crashed
run — teardown should be resilient and the pattern gitignored.)

## Why Linux passes

- `path.relative`/`path.join` emit `/` on Linux, so A1–A6 never surface.
- Linux `os.tmpdir()` is `/tmp`, matching the A7 hardcode.
- Linux `rm -rf` on the temp dir has no long-path/locking constraint (B2).
- The B1 fs-mock keys (`/virtual-caco-home/...`) match `path.join` output on
  Linux exactly.

## Design: the single principle

**Normalize to POSIX at every emit boundary; keep native separators only for
real filesystem calls that stay on the host.** This is already Caco's stated
convention (`toPosix` doc comment). The fixes extend it to the six emit points
that predate it (A1–A6) and make the one allowlist temp-dir-aware (A7).

`toPosix` is safe to apply even to paths later handed back to `fs` on Windows,
because Node accepts `/`-separated paths on Windows. But to minimize blast
radius, A1/A2 normalize only the value that leaves the function (the returned
list / the `jiti` argument), not internal fs operations.

## The server-crash defect (why running the suite killed Caco)

Running `vitest` repeatedly crashed the live Caco server (which the dev session
runs inside), interrupting work. Two-part root cause, now captured as **A9**
(product) + **B3** (test):

- The live server watches its session cwd (the repo root) via the chokidar
  file-watcher + git-edit-poller, and watches `<cwd>/.caco/extensions` +
  `~/.caco/extensions` via a **raw `fs.watch` with no `'error'` handler** (A9).
- `api-route-harness` created and force-deleted a temp tree **inside that
  watched repo root** on every run (B3), producing Windows EPERM `'error'`
  events (→ A9 crash) plus a `git diff` subprocess storm.

Linux never crashed: `fs.watch` there doesn't emit EPERM on watched-dir
deletion and `rm -rf` of a watched dir is benign. Fixing either half stops the
crash; we fix both — B3 removes the trigger, A9 removes the latent crash vector.

## Implementation Plan

### Reviewer resolutions (gpt-5.3-codex)

Confirmed A1,A2,A4,A5,A6,A7,B1; widened A3 (doc-body header, not just index);
added **A8** (file-watcher — same `ignore`-needs-POSIX root cause as A1 at an
independent call site); B2 applies to both harness files. Open-question
recommendations adopted: (1) keep current absolute path shape, normalize
separators only; (2) fix B1 in the test via `join()`; (3) lint guard is an
out-of-scope follow-up.

Each change is a small, isolated edit, reviewed by a `gpt-5.3-codex` `task`
before commit (per the workflow request). Order:

1. **A1** walkProjectFiles POSIX (also restores gitignore correctness). Import
   `toPosix` in `src/routes/api.ts`.
2. **A2** extension-runtime jiti import POSIX.
3. **A3** dev-docs index POSIX.
4. **A4** applet-store asset path POSIX.
5. **A5** browser-tools screenshot path POSIX.
6. **A6** session-auto-repair split on `[\\/]`.
7. **A7** workspace-api `ALLOWED_BASES` add `tmpdir()`.
8. **A8** file-watcher POSIX-normalize `rel` before `ig.ignores`.
9. **A9** extension-store: add `'error'` handler to the raw `fs.watch` so a watch
   error can never crash the server (server-stability fix).
10. **B1** auto-repair test mock keys via `join()`.
11. **B2** harness teardown `rmSync` retries + `.gitignore` for `.api-route-harness-*`.
12. **B3** relocate api-route-harness temp root to `os.tmpdir()` (stop churning the
    watched repo — the direct cause of the server crash during test runs).
13. **Verify**: full `vitest run` to a durable log; expect 0 platform failures AND
    no server crash (tests no longer churn the watched repo; watch errors are caught).

## Risks & Mitigations

- **R1: `toPosix` on a path still used for fs I/O could double-normalize or
  break UNC paths.** Mitigation: apply only to returned/model-facing values;
  never mutate the variable used for the subsequent `fs` call. UNC (`\\server`)
  is out of scope (Caco operates under homedir/cwd).
- **R2: A7 widening `ALLOWED_BASES` to the whole OS temp dir enlarges the
  writable surface of the MCP file routes.** Mitigation: `os.tmpdir()` is
  already an intended allowed area (the `/tmp` entry proves intent); we are
  making the existing intent correct on Windows, not adding a new class of
  path. Still gated by `validatePath` traversal checks.
- **R3: B2 retry masks a real leak.** Mitigation: retries are bounded; a
  persistent failure still surfaces. The leaked-dir gitignore is cosmetic.
- **R4: A1 changes gitignore behavior on Windows (from broken to working),
  which could change which files a Windows user sees in the file browser.**
  This is the intended fix; call it out in the commit so it's not a surprise.

## Test / Verification Strategy

- Re-run the full suite on Windows via `vitest run` to a durable logfile
  (detached; the build/`--coverage` path can destabilize the host — tests only,
  no `npm run build`).
- Confirm the 10 previously-failing files pass and the pass count is unchanged
  otherwise (Linux parity preserved).
- Spot-check A1 by confirming a gitignored file is now excluded from
  `walkProjectFiles` output on Windows (behavioral, not just separator).

## Open Questions for Review

1. For A3/A4/A5, should paths be emitted **relative** (POSIX) rather than
   absolute-with-forward-slashes? Current tests only assert `/`-separators and a
   suffix match, so `toPosix` on the existing (absolute) path satisfies them.
   Absolute-vs-relative is a separate design choice; this spec keeps the current
   shape and only fixes separators. Confirm that's acceptable.
2. B1: prefer fixing the **test** (build keys with `join`) vs. making the fs
   mock separator-insensitive? Spec proposes the former (smaller, explicit).
3. Should we add a lint/CI guard to prevent future `\`-leak regressions
   (e.g. forbid returning `path.relative`/`path.join` results from model-facing
   functions without `toPosix`)? Proposed as out-of-scope follow-up.
