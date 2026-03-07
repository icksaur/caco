# plan

This document must only contain the next actions, no cut or deferred work.
The items in this plan must be actionable by another agent without guesswork.
When all items are complete, remove all items.

legend:

[ ] incomplete
[*] complete
[>] in progress

---

## File Finder + Dotfiles + Copy Path (doc/features/file-finder.md)

### Step 1: Server — dotfiles query param

[*] `src/routes/api.ts` `GET /api/files`:
  - Read `req.query.dotfiles` as boolean
  - In the filter chain, change `!e.name.startsWith('.')` to also check if dotfiles param is truthy
  - If `dotfiles=1`, skip the dot-prefix filter

[*] `src/routes/api.ts` `walkProjectFiles()`:
  - Add `dotfiles` parameter to the function signature
  - Pass it through from `GET /api/project-files` query param `dotfiles`
  - When truthy, skip the `entry.name.startsWith('.')` check (line 527)

### Step 2: File-browser — dotfiles toggle + copy button

[*] `applets/file-browser/script.js`:
  - Add a toggle checkbox in the header area labeled "Show dotfiles"
  - When toggled, re-fetch with `&dotfiles=1` appended to the API URL
  - Persist toggle state in applet state

[*] `applets/file-browser/script.js`:
  - Add a 📋 copy button to each file/directory entry
  - On click, call `navigator.clipboard.writeText(fullAbsolutePath)` and show brief "Copied!" feedback
  - Prevent click from propagating to the file-open/directory-navigate handler

[*] `applets/file-browser/style.css`:
  - Style the copy button: small, muted, appears on hover of file-item row

### Step 3: File-finder applet

[*] Create `applets/file-finder/meta.json`:
  - slug: "file-finder", name: "File Finder"
  - params: `root` (required, absolute path to search directory)
  - agentUsage.purpose: "Fuzzy find files in a directory tree and copy paths to clipboard"

[*] Create `applets/file-finder/content.html`:
  - Search input at top with placeholder "Search files..."
  - Refresh button next to search input
  - Scrollable results list div
  - Status bar at bottom (file count)

[*] Create `applets/file-finder/script.js`:
  - On load (via onUrlParamsChange), fetch `GET /api/project-files?cwd=<root>`
  - Store full file list in a variable
  - On input: fuzzy-filter client-side using simple substring + word-boundary scoring
  - Render results: each row shows relative path, click copies `root + '/' + relativePath` to clipboard
  - Each row has an open link (📄) that navigates to markdown-viewer for .md files, text-editor otherwise
  - Refresh button: clear client file list, re-fetch from server (30s TTL cache — new files appear after cache expires)
  - On missing root param: show usage hint ("Use ?applet=file-finder&root=/path/to/folder")
  - On fetch error: show error message in applet with the path that failed
  - Keyboard: ArrowUp/Down to navigate results, Enter to copy selected
  - Show "Copied!" toast briefly on successful copy

[*] Create `applets/file-finder/style.css`:
  - Match text-editor sizing: max-width 900px, margin 0 auto, 11pt font
  - Search input: full width, dark background, border-radius
  - Results: scrollable list, selected highlight, hover highlight
  - Copy feedback: brief green flash on the row

### Step 4: Build and test

[*] Run `npm run build:client` — must succeed
[*] Run `npx tsc --noEmit` — must pass
[*] Run `npx vitest run` — no new failures (pre-existing failures are acceptable)
[ ] Restart server, manually verify:
  - file-finder loads files and fuzzy search works
  - Click copies path to clipboard
  - Open link navigates to correct viewer
  - Refresh re-fetches
  - file-browser dotfiles toggle works
  - file-browser copy button works
