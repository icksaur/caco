# files-applet V5 implementation plan review

Review target: `plan.md` on branch `files-applet-v5`.
Reference spec: `docs/files-applet-v5.md`.
Quality bar: `code-quality.md` — correctness first, simple/maintainable changes, avoid side-effect reliance, protect regressions with tests.

## BLOCKER

### BLOCKER: Redirect-IIFE + flag pattern is not correct for the standalone scripts

The plan's §8.2 says to prepend a redirect IIFE and then have the "existing applet's IIFE" bail when `window.__filesDeprecatedRedirect` is set. That does not match the current standalone scripts:

- `markdown-viewer/script.js`, `image-viewer/script.js`, `html-viewer/script.js`, and `file-finder/script.js` are not self-contained IIFEs. They are plain top-level applet scripts.
- The runtime wraps all applet JS in an outer IIFE during injection (`public/ts/applet-runtime.ts:890-894`), but there is no per-script inner IIFE to add a first-line `if (window.__filesDeprecatedRedirect) return;` to.
- `onUrlParamsChange()` calls its callback immediately (`public/ts/applet-runtime.ts:371-379`). If the redirect IIFE only sets a flag and then the rest of the file continues executing, the deprecated applet will synchronously register handlers and may immediately start rendering/fetching before navigation completes.

This violates the spec's active-session redirect behavior and the plan's smoke expectation of "no visible stub render." It also relies on navigation side effects rather than making the old body unreachable, which conflicts with `code-quality.md`'s guidance against side-effect reliance.

Fix recommendation: make the guard structurally own the entire script body. Use one of these patterns per stub:

```javascript
(function() {
  function redirectedToFilesIfSession() { /* build target + navigate; return true/false */ }
  if (redirectedToFilesIfSession()) return;

  // existing standalone script body moved here unchanged
})();
```

or:

```javascript
if (!redirectedToFilesIfSession()) {
  // existing standalone script body
}
```

Do not use a global `window.__filesDeprecatedRedirect` flag unless the plan also explicitly wraps every existing top-level statement in a guard. A local `redirected` boolean is simpler and avoids global state.

### BLOCKER: `openFinderRoot` no-session support is incomplete; listing works, selection/copy path is wrong

The plan correctly asks whether `/api/project-files?cwd=...` needs a session header. It does not: `src/routes/api.ts:539-568` reads only `cwd`, `q`, `dotfiles`, and `noignore`; it does not require a session id.

However, the picker will not fully function without a session with only the plan's changes:

- `runPickerFetch()` can list files under `_pickerRootOverride`, because `/api/project-files` accepts `cwd` directly.
- The returned file names are relative to `rootOverride`.
- `pickSelected()` calls `routeOpen(relativePath)`.
- `routeOpen()` computes `abs = absPathOf(relativePath)`.
- `absPathOf()` uses `cachedCwd`, and when there is no session/cwd it returns the relative path unchanged (`applets/file-edits/script.js:2216-2220`).

So `?applet=files&openFinder=1&openFinderRoot=/repo` can show `/repo`'s files, but selecting `README.md` attempts to open `README.md` rather than `/repo/README.md`. The copy button has the same issue because it also uses `absPathOf(p)`.

Fix recommendation: while `_pickerRootOverride` is set, `absPathOf()` or the picker row data must resolve relative paths against `_pickerRootOverride`. The cleanest surgical fix is a helper such as `pickerAbsPathOf(rel)` used by picker copy and selection, or a generalized `absPathOf(relativePath, rootOverride)` that defaults to `cachedCwd`. Add a manual smoke assertion that selecting a file from new-chat Ctrl+P actually opens the selected file, not just that results appear.

### BLOCKER: Commit 2 creates a broken intermediate runtime state

The suggested commit order has:

1. add `deprecated` fields to `AppletMeta`
2. add `SLUG_ALIASES['file-edits'] = 'files'`
3. `git mv applets/file-edits applets/files`

After commit 2, `loadApplet('file-edits')` resolves the alias to `files`, but `applets/files` does not exist yet. The old `applets/file-edits` directory is no longer considered because alias resolution is one-way (`src/applet-store.ts:105-117`). This means old `?applet=file-edits` URLs fail until commit 3.

Fix recommendation: combine the alias addition with the directory rename, or reorder so the alias is introduced in the same commit that creates `applets/files`. If every commit is expected to be buildable/runnable, do not land alias-before-rename as a standalone commit.

## IMPORTANT

### IMPORTANT: `appletAPI.getSessionId()` is the correct API name, but the plan should avoid stale spec names

`public/ts/applet-runtime.ts` exposes `getSessionId` in the applet API interface and implementation:

- interface entry: `getSessionId: typeof getActiveSessionId` (`public/ts/applet-runtime.ts:218`)
- runtime object: `getSessionId: getActiveSessionId` (`public/ts/applet-runtime.ts:261`)

So plan §8.2 is correct to use `window.appletAPI.getSessionId()`. The spec still contains older placeholder wording around `getSession()` in §4.2/§4.8, but the plan has the right name.

Fix recommendation: keep `getSessionId()` in the implementation plan and tests. Do not implement `getSession()` or add a compatibility alias for this V5 work.

### IMPORTANT: `openPicker` edit location is underspecified and the snippet is order-sensitive

Current `openPicker` starts with:

```javascript
function openPicker(opts) {
  if (!sessionId || pickerOpen) return;
  opts = opts || {};
```

Plan §7.3 says to change the guard to:

```javascript
if (!sessionId && !opts.rootOverride) return;
```

If implemented literally at the current guard location, `opts` can be `undefined`, causing a throw when callers use `openPicker()` without arguments.

Fix recommendation: make the plan explicit:

```javascript
function openPicker(opts) {
  opts = opts || {};
  if ((!sessionId && !opts.rootOverride) || pickerOpen) return;
```

Then set `_pickerRootOverride` immediately after the guard. This is small, but without the ordering detail it is easy for Sonnet to introduce a regression.

### IMPORTANT: Persistence migration step uses imprecise function names and the wrong return-shape assumption

Plan §6 refers to `loadPersistedCards` and a `null` return. The actual public read function in `src/file-edits-store.ts` is `getCardList(sessionId)`, and it always returns a `CardList` shape, not `null`, even when no persisted data exists (`src/file-edits-store.ts:49-65`). The raw nullable primitive is `getSessionData()`.

Fix recommendation: rewrite step 6 for the actual seam:

- import `deleteSessionData` alongside `getSessionData` and `setSessionData`.
- add `const LEGACY_STORE_NAME = 'file-edits-cards';`.
- inside `getCardList`, read `const raw = getSessionData(sessionId, STORE_NAME);`.
- if `raw` is absent, read `legacyRaw = getSessionData(sessionId, LEGACY_STORE_NAME)`.
- only after `setSessionData(sessionId, STORE_NAME, legacyRaw)` returns `true`, call `deleteSessionData(sessionId, LEGACY_STORE_NAME)`.
- parse whichever raw object was selected through the existing validation path.

This keeps migration correct and avoids duplicating parse logic.

### IMPORTANT: `setSessionData` success must gate legacy deletion

The spec requires explicit copy + delete. The plan's snippet calls `setSessionData(...)` and then `deleteSessionData(...)` without checking the boolean return from `setSessionData`. In this case `STORE_NAME` is safe and writes should normally succeed, but the primitive explicitly returns success/failure (`src/session-data-store.ts:41-47`).

Fix recommendation: delete the legacy key only when `setSessionData(...) === true`. If copy fails, return the legacy data for the current read but leave the old file in place so a later read can retry.

### IMPORTANT: Applet-browser plan needs one more implementation detail for API/runtime metadata

Plan §3 correctly notes `/api/applets` may whitelist fields, and it does: `src/routes/api.ts:230-237` currently returns only `slug`, `name`, `description`, `params`, `updatedAt`, and `paths`. Plan §9.3 then asks the browser script to filter by `entry.deprecated` and render `replacedBy`.

That is implementable, but the plan should explicitly connect the pieces:

- add `deprecated` and `replacedBy` to the `/api/applets` response;
- optionally update the TypeScript return type of `listSavedApplets()` in `public/ts/applet-runtime.ts:741-746` to include these fields, even though the applet script is plain JS.

Fix recommendation: amend §3 or §9.3 to mention the applet runtime type, so future TS callers and generated declarations do not drift from the backend shape.

### IMPORTANT: `caco_applet_usage` filtering should not advertise deprecated slugs in the "not found" fallback

Plan §9.2 says the lookup-by-slug path can return "not found" or a deprecation notice. Current code builds the fallback list from all applets (`src/applet-tools.ts:444-448`). If implementation filters `filtered` but leaves the fallback list as `applets.map(...)`, the tool will still tell agents the deprecated slugs are available.

Fix recommendation: compute `visibleApplets = applets.filter(a => !a.deprecated)` once. Use `visibleApplets` for unfiltered usage, slug lookup, and the "Available:" fallback. For a deprecated slug, return either a concise deprecation message pointing at `files`, or "not found" with only non-deprecated slugs listed.

### IMPORTANT: `git mv` preserves rename tracking, but blame preservation is tool-dependent

`git mv --dry-run applets/file-edits applets/files` reports a normal rename for the directory and each child file. This is the right operation.

However, Git does not store persistent rename metadata; it detects renames by content similarity at diff/log time. `git blame` does not follow renames unless invoked with `--follow` for a single file, while GitHub's UI generally detects renamed files when similarity remains high. Editing `script.js` heavily in the same commit as the move can reduce similarity and make history harder to follow.

Fix recommendation: keep the `git mv` commit as rename + `meta.json` slug/name/description only. Put larger `script.js` changes in later commits after the rename. If preserving blame is a hard requirement, verify with `git log --follow -- applets/files/script.js` after the rename.

### IMPORTANT: Smoke step does not cover all acceptance items 1-19

Plan §12 covers important flows, but not all acceptance criteria. Gaps:

- §8.1: no explicit check that `applets/file-edits/` is gone, `applets/files/` exists, and `meta.json.slug === "files"`.
- §8.2: covered by unit test in step 11, not by smoke.
- §8.4: no explicit check that all four deprecated `meta.json` files contain `deprecated: true` and `replacedBy: "files"`, or that the redirect guard is at the top of each script.
- §8.9: smoke checks no-session `image-viewer` only; it does not check no-session `markdown-viewer`, `html-viewer`, or `file-finder`.
- §8.10: smoke checks new-chat Ctrl+P, but not direct `?applet=files&openFinder=1&openFinderRoot=ABS` plus selecting a file.
- §8.11: no smoke/tooling check that a newly built system prompt omits the four deprecated slugs.
- §8.12: no check that `caco_applet_usage` hides or rejects deprecated slugs.
- §8.13: no direct `/api/applets` response check for `deprecated` and `replacedBy`.
- §8.16: Ctrl+P/footer are covered, but `src/prompts.ts:74` and `src/browser-tools.ts` are not directly checked except by review/grep.
- §8.17: no check that `_PICKER_FILE_ICONS` and standalone `file-finder`'s `fileIcons` remain unchanged.

Fix recommendation: add a short grep/API/tool checklist after build, and expand manual no-session smoke to all four deprecated stubs. The build covers §8.18.

### IMPORTANT: Plan omits direct verification of the `src/browser-tools.ts` tool description change

The spec acceptance §8.16 includes `src/browser-tools.ts` screenshot wrapping with `files`. The plan has step 10.4, but the smoke list does not verify it. Because this is an agent-facing tool description, it is easy to miss in manual browser smoke.

Fix recommendation: add a post-edit grep check: `grep -R "image-viewer" src/browser-tools.ts` should return no matches, and the screenshot tool description should mention `files`/`openPath`.

### IMPORTANT: Step 8.3 says unknown URL params are passed through in the spec, but the plan translations drop them

Spec §4.3 says unknown URL params are passed through unchanged. Plan §8.3 translations only preserve `path` for viewers and `root` for file-finder. If future or existing links contain additional params, the plan does not tell the implementer to copy them to the target URL.

Fix recommendation: either explicitly implement pass-through in §8.3 or update the spec. A simple implementation is to start `targetParams = new URLSearchParams(p)`, delete/translate `applet`, `path`, and `root`, set the new `applet` plus translated params, then navigate to `?` + `targetParams.toString()`.

### IMPORTANT: Step 9.3 applet-browser details are barely enough, but should name the render structure

The current applet browser is tiny: `content.html` has only `h1`, `p.subtitle`, and `#applet-list`; `script.js` renders all HTML in one async IIFE. Plan §9.3 says "add a checkbox to the header," but there is no header element.

Fix recommendation: specify the concrete target: add the checkbox near the subtitle in `content.html`, read it in `script.js`, and factor rendering into a `renderList()` function that applies the local-storage-backed `showDeprecated` state. This avoids guesswork and keeps the change simple.

## MINOR

### MINOR: The spec still has an icon-map consolidation contradiction

The spec's §1 says V5 includes consolidating the duplicated `_PICKER_FILE_ICONS` map, but acceptance §8.17 says `_PICKER_FILE_ICONS` is unchanged in V5 and the standalone `file-finder` keeps its copy until V6. The plan follows the acceptance item and the user's five-change scope, not the older §1 wording.

Fix recommendation: no plan change is needed if V5 scope is the five coupled changes listed by the user. Note the spec inconsistency for the implementer so they do not attempt an extra icon-map refactor.

### MINOR: Step 5 metadata wording should include params/stateSchema preservation

Plan §5 says to edit `meta.json` slug/name/description and `agentUsage.purpose`. Current `applets/file-edits/meta.json` has empty `params` and no `stateSchema`, so this is safe today.

Fix recommendation: say "preserve any existing `params`, `stateSchema`, `createdAt`, and `updatedAt` unless intentionally updating timestamps." This prevents accidental metadata loss if the file changes before implementation.

### MINOR: Step 15 is implementation work beyond V5 acceptance and may surprise the implementation session

Plan §15 includes merging to `master`, updating `docs/files-applet-roadmap.md`, and pushing. The spec acceptance §8 ends at build/manual smoke; the roadmap update is useful project hygiene but is not part of the V5 code acceptance.

Fix recommendation: keep roadmap update as a post-merge task, but separate it from the V5 implementation commits so reviewers can distinguish feature behavior from project bookkeeping.
