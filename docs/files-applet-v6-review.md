# files-applet V6 spec review

Reviewed `docs/files-applet-v6.md` against `code-quality.md` and the referenced implementation files. No ASCII ownership diagrams were found; the spec uses prose and markdown tables.

## BLOCKER: Tab identity scheme can collide with real paths and ambiguous range ids

`§4.3` proposes keeping unstaged ids as `relPath`, staged ids as `'diff-staged:' + relPath`, and range ids as `'diff-range:' + ref + ':' + relPath`.

This is not collision-safe:

- A real unstaged file named `diff-staged:README.md` collides with the staged tab for `README.md`.
- `diff-range:` ids are ambiguous because both `ref` and `relPath` may contain `:` under the proposed ref grammar. For example, different `(ref, relPath)` pairs can serialize to the same string.
- The current `TabContainer` constructor hard-codes `this.id = descriptor.viewerType === 'markdown' ? 'markdown:' + absPath : relPath` in `applets/files/script.js:215-223`; V6 needs an explicit id source, not just a new convention in prose.

Recommendation: make tab ids an encoded structured value, or add an explicit `container.diffMode`/`container.diffRef` plus a centralized `diffTabId({ mode, ref, relPath })` helper that cannot collide with user paths. If backward compatibility requires unstaged ids to remain `relPath`, staged/range ids must still use an escaping/length-prefix scheme that cannot be confused with any valid relPath.

## BLOCKER: `findContainerByRelPath` is not only a poller helper

`§4.3` and `§5.4` say `findContainerByRelPath` is safe because dedup-on-poll only fires for unstaged tabs. Current code does not match that model.

Current implementation (`applets/files/script.js:159-165`) returns the first container with `c.relPath === relPath`, regardless of id or mode. It is used by more than poller updates:

- `routeOpen` activates an existing tab by relPath before opening anything (`script.js:2262-2271`). A staged/range deep link for a file that already has an unstaged tab would focus the unstaged tab and drop the requested mode.
- `routeOpen` race checks by relPath (`script.js:2294-2301`).
- `openOrUpdateTab` uses it for `caco.edit` updates (`script.js:1417-1424`).
- Other tab paths also use relPath lookup.

Recommendation: spec a mode-aware lookup and update every call site intentionally. Poller events should find only the unstaged working-tree tab. User opens should find the exact target tab id/mode/ref. Existing markdown/default-viewer dedup behavior needs a separate rule from diff-mode dedup.

## IMPORTANT: `DiffViewer.open` and `DiffViewer.fromEdit` need separate V6 responsibilities

`DiffViewer.open` currently fetches `/file-edits/open` with only `{ relativePath }` (`applets/files/diff-viewer.js:142-161`). `DiffViewer.fromEdit` constructs from already-fetched poller edit data (`diff-viewer.js:167-171`) and is used by `openOrUpdateTab`, agent state, and persistence placeholders.

V6 should not describe this as only “DiffViewer renders whatever text it receives.” The opening path must carry `diffMode`/`diffRef` through `routeOpen` → viewer descriptor → `DiffViewer.open` → API body. The `fromEdit` path should remain for poller-provided unstaged edit data unless a caller already fetched a staged/range snapshot.

Recommendation: add an implementation subsection that names the fetch path and says `DiffViewer.open(shell, container, abs, rel, opts)` posts `{ relativePath, diffMode, ref }`; `fromEdit` does not infer modes from raw edit data.

## IMPORTANT: Persistence is additive only if schemaVersion stays compatible and rehydrate changes are explicit

The forward-compat claim in `§6.2` is mostly viable: current server/card validation ignores unknown object keys, so additive `diffMode`/`diffRef` fields can survive without a schema bump if the route continues accepting `schemaVersion: 2` (`src/routes/file-edits.ts:143-157`, `src/file-edits-store.ts:68-90`).

But current client rehydrate logic is not mode-aware:

- `buildPersistBody` writes only `relativePath`, `defaultViewerType`, and `activeViewerType` (`applets/files/script.js:1742-1757`).
- `initFromPersistence` checks `tabs.has(c.relativePath)` and creates a default tab from `defaultViewer(abs, c.relativePath)` (`script.js:2995-3041`).
- Diff tabs rehydrate with a placeholder and then `fetchSnapshot()` updates unstaged working-tree data (`script.js:3030-3041`, `3081-3082`). That cannot restore staged/range snapshots.
- If V6 bumps to schemaVersion 3, current `PUT /cards` rejects it and `initFromPersistence` treats `isV2` as false.

Recommendation: state that V6 remains schemaVersion 2 unless the route and client version checks are updated together. Specify that persisted staged/range tabs rehydrate through the same mode-aware `DiffViewer.open` snapshot path, not through the current placeholder + `fetchSnapshot()` unstaged path.

## IMPORTANT: Ref validation is internally inconsistent with gitrevisions

`§5.3` says the regex supports normal git revision syntax, including `@{2.days.ago}`, but the allowed character list omits `{` and `}`, so that example would be rejected. Git revision grammar also includes common forms like `@{-1}`, `HEAD^{tree}`, `HEAD^!`, `HEAD^-`, `:/regex`, and reflog dates containing spaces.

The rule is also loose in places: allowing `:` while accepting arbitrary revision text admits `rev:path`-style syntax, even though V6 wants a revision/range argument followed by `-- <relPath>`, not a tree path expression.

Recommendation: either document a deliberately narrow supported subset (`HEAD`, hashes, branch/tag names, `A..B`, `A...B`, `~`, `^`) and remove unsupported examples, or use git itself to validate after minimal safety checks. Keep the safety checks that matter for argv use: non-empty, no NUL/control characters, no leading `-`, and no argument separator confusion. Add tests for every documented accepted form and every rejected form.

## IMPORTANT: `git-status` ABS construction should use a join helper

`§4.6` says to build `ABS` as `path + '/' + filePath`. Current `git-status` stores an absolute repo path from either URL `path` or session `info.cwd` (`applets/git-status/script.js:648-707`), and parsed git status paths are repo-relative (`script.js:77-121`). So git-status does know the absolute repo path.

The proposed join is still brittle: trailing slashes in `repoPath` produce double separators, and defensive stripping of leading separators from `filePath` avoids accidental absolute override if a future parser changes.

Recommendation: specify a small browser-side helper mirroring `files` applet path joining: trim trailing `/` or `\` from `repoPath`, strip leading `/` or `\` from `filePath`, choose the separator from `repoPath`, then concatenate. Also update the URL via `URLSearchParams` rather than string concatenation.

## IMPORTANT: The “remove View diff link” mitigation is inaccurate

Removing the clean-state last-commit `View diff` link (`git-status/script.js:517-522`) is within the one-file-at-a-time constraint, but `§6.5` says “the file-list area below the last-commit still shows the file diff per file.” In the current clean-state UI, the last-commit section shows commit metadata and `--stat`; it does not render a clickable per-file list for `HEAD~1..HEAD`.

Recommendation: either accept and describe the regression honestly, or replace the link with a scoped V6-compatible affordance, such as a future-work placeholder or a per-file list if that is allowed. As written, the mitigation overstates the remaining UI and may hide a real user-visible loss.

## IMPORTANT: Ref-only stub should probably redirect to git-status, not empty files

`§5.5` redirects `?applet=git-diff&path=REPO&ref=R` to bare `?applet=files`, losing the repo path and landing on an empty state. Because the old URL contains `path=REPO`, `git-status` can preserve useful context while still avoiding a multi-file files tab.

Recommendation: redirect ref-only URLs to `?applet=git-status&path=REPO` instead of empty `files`, or explicitly justify why losing the repo context is preferable. This is especially important when the session cwd differs from the old git-diff `path` param.

## MINOR: Refresh button infrastructure exists, but `_reload()` does not

The files applet already has generic chrome-button infrastructure: active viewers can expose `getChromeButtons()` and `TabContainer.updateChromeButtons()` renders mode-conditional buttons (`applets/files/script.js:461-571`). So V6 does not need a new TabContainer chrome hook.

However, `DiffViewer` currently has no `getChromeButtons()` and no `_reload()` method (`applets/files/diff-viewer.js:1-181`).

Recommendation: adjust `§6.3`/`§8.14` to say V6 adds `DiffViewer.getChromeButtons()` and a new reload method that reuses the mode-aware open endpoint. Do not imply `_reload()` already exists.

## MINOR: No `git-diff -> files` `SLUG_ALIASES` entry is needed

Confirmed: `src/applet-store.ts:107-110` currently aliases `file-edits -> files`, and V5 correctly says aliases are for same-param-shape slug migrations. `git-diff` has different params (`path`, `file`, `staged`, `ref`) from `files` (`openPath`, `diffMode`, `diffRef`), so it needs a conditional stub, not a server alias.

Recommendation: keep V6 explicit that `git-diff` is not added to `SLUG_ALIASES`; the stub owns URL translation.

## MINOR: `git-diff` has no staging controls

The V6 framing correctly incorporates the user correction: `git-diff` is read-only and has no staging controls; staging controls live in `git-status`. No change needed.
