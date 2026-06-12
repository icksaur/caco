# Files applet V7 plan review

Verdict: REVISE

Reviewed `plan.md` against `docs/files-applet-v7-no-session.md` rev 3 and spot-checked the current code.

## Acceptance mapping

Spec §8 item coverage by plan step:

- 1-4: steps 1, 3, 6, 7, 14.
- 5: steps 1, 3, 4, 6, 7, 14.
- 6: step 7; manual coverage missing in step 14.
- 7: step 7; manual coverage missing in step 14.
- 8: steps 2, 6, 7, 14.
- 9: not sufficiently covered; see BLOCKER-1.
- 10: steps 5, 7, 14.
- 11: steps 5, 6, 14.
- 12: steps 5, 7, 14.
- 13-14: steps 7, 14.
- 15/15a: steps 5, 7, 14.
- 15b/15c: steps 1, 3, 4, 7; step 14 only covers markdown-to-source, not HTML-to-source.
- 16-18: steps 7, 13, 14.
- 18a: step 7 says do not change `_isContainedIn`; manual coverage missing in step 14.
- 19: step 7 boot split, by not subscribing sessionless mode to session-change/session-event wiring; manual coverage missing in step 14.
- 20-29: steps 8, 9, 13, 14.
- 30-32: steps 11, 13, 14.
- 33-36: step 10 partially; step 14 does not smoke these, and `git-status` is omitted from the step 10 audit list.
- 37: steps 8, 13.

## Findings

### BLOCKER-1: Acceptance item 9 is not produced by the plan

Acceptance 9 requires closing the only sessionless tab to leave the sessionless empty-pane usage hint. The current `content.html` default is session-mode text: `No files open. Click + to open one, or wait for edits.` Step 7 only sets the sessionless hint in the no-params boot path. For a valid `openPath`, the tab opens without changing `#fePaneEmpty`; after closing the tab, `updateEmptyState()` will reveal the old session-mode hint while `#feOpen` is hidden.

Add an explicit step to set the sessionless empty-pane hint during `bootSessionless` before dispatching `openPath` / `openFinder`, and ensure `setEmptyPaneError()` can be cleared/restored to that hint after successful tabs close.

### IMPORTANT-1: Step 4 hard-codes `readOnly: true` for lazy viewer construction

Step 4 tells `TabContainer.switchViewer()` to pass `{ readOnly: true, watch: ... }`. That is correct for sessionless and external opens, but not for session-mode in-cwd lazy MarkdownViewer construction. Spec §4.2 says session-mode in-cwd markdown editability is unaffected, and acceptance 16 requires markdown Edit/Save to keep working.

Use capabilities instead: `readOnly: (caps && caps.canEdit) === false`, with the same pre-step-7 default-to-editable behavior as watch. The watch guard pattern itself is correct: `(shell.capabilities && shell.capabilities.canWatch) !== false` defaults to true when capabilities are undefined.

### IMPORTANT-2: Boot split is realistic, but the registry/shell instructions need one more explicit assignment

The bottom wiring block at `applets/files/script.js:3452-3582` can realistically be extracted into `bootSession(existingId)`, with a sibling `bootSessionless(params)`. Existing session subscriptions are localized enough for the split.

However, the current file has both a global `viewerRegistry` (`script.js:245`) and `shell.viewers: viewerRegistry` (`script.js:335`), while helper functions like `defaultViewer()` and `defaultExternalViewer()` read the global. If `buildViewerRegistry(capabilities)` returns a new array, implementation must explicitly do both:

- `viewerRegistry = buildViewerRegistry(capabilities)`
- `shell.viewers = viewerRegistry`

or refactor all registry readers to use `shell.viewers`. Without that instruction, a Sonnet implementation could update only `shell.viewers` while default selection still reads an empty/stale global registry.

### IMPORTANT-3: Step 10 omits `applets/git-status/script.js` from the link audit

Spec §4.9 includes `applets/git-status/script.js` as a regression check. The current file still has `file-finder` links at lines around 672 and 720 for repo path labels. Even if acceptance 36 specifically says per-file diff links already open in `files`, V7 deletes `file-finder`; new in-app links should not rely on redirects.

Add `applets/git-status/script.js` to step 10 and step 14 link-callsite smoke checks.

### IMPORTANT-4: Manual smoke coverage misses several §8 acceptance items

Step 14 should add explicit checks for:

- item 6: `#feOpen`, `#feFollow`, and `#feNotGit` hidden in sessionless.
- item 7: DiffViewer absent from every sessionless viewer toggle.
- item 9: closing the only sessionless tab shows the sessionless usage hint.
- item 15c: HTML tab toggled to SourceViewer without `watchPath` errors.
- item 18a: symlink/lexical containment behavior unchanged, or at least a targeted regression note if impractical manually.
- item 19: sessionless page does not auto-upgrade when a session appears.
- items 33-36: text-editor, image-gallery, session-context, and git-status links open in `files`.

### IMPORTANT-5: Step 11 is achievable, but wording should mention metadata rather than `applet-store.ts` entries

Actual `src/applet-store.ts` has:

```ts
const SLUG_ALIASES: Record<string, string> = {
  'roadmap': 'session-context',
  'file-edits': 'files',
};
```

There are no deleted-slug aliases in `SLUG_ALIASES`. `deprecated` / `replacedBy` are interface fields in `src/applet-store.ts`, while the actual deprecated entries live in the deleted applets' `meta.json` files. Step 11 is achievable as written because deleting the directories removes those metadata entries, but it should say the likely outcome is “no `SLUG_ALIASES` changes; deleted applet `meta.json` files contain the deprecated entries.” Keep the `files-cards` storage name untouched.

### IMPORTANT-6: Step 8 mostly matches §4.7, but add explicit param-deletion expectations

The redirect rules match spec §4.7, including markdown/image/html, file-finder with and without root, git-diff file staged/unstaged, git-diff ref to git-status, unknown-param preservation, no-loop, and unknown-slug null.

To avoid ambiguity, Step 8 should explicitly say translated params are removed from the target: `path`, `file`, `staged`, `ref`, and `root` are not preserved under their old meanings, except `path` is re-added for the `git-diff&ref=` → `git-status` case when present.

### MINOR-1: Step ordering is mostly correct

No step appears to depend on a later step in a way that blocks buildability. The step 4/6 capability reads happen before step 7, but the proposed guard defaults to current behavior when `shell.capabilities` is undefined, so that ordering is safe. Step 11 correctly comes after steps 8 and 9 so legacy URLs have server-side redirects before stubs are deleted.

### MINOR-2: `applyCapabilities` should include durable `updateFollowButton()` behavior

Step 7 mentions hiding `#feFollow` and separately says `updateFollowButton` should hide and return when `!canFollowEdits`. Keep both. The current `updateFollowButton()` unconditionally re-shows the button whenever `followEdits` is false, so the early return is required for acceptance 6.
