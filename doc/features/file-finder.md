# File Finder

## Goal

Provide a fast fuzzy file search applet for locating files in large directory trees far from the session's CWD. Primary use case: finding markdown documents in a large docs folder to reference or guide agents.

Secondary: show dotfiles in file-browser and add path copy buttons.

## Design

### File Finder Applet

A new `file-finder` applet with a search input and scrollable results list.

**URL**: `?applet=file-finder&root=/path/to/docs`

**Behavior**:
1. On open, fetch full file list from `GET /api/project-files?cwd=<root>` (already exists — recursive walk with 30s TTL cache, 10k cap, .gitignore respect)
2. Store file list client-side for instant fuzzy filtering
3. Search input at top — filters as you type using fuzzy scoring
4. Results list below — each entry shows:
   - Relative path (the filename)
   - Click: copies full absolute path to clipboard (primary action — the whole point)
   - Open link icon: opens in markdown-viewer (for .md) or text-editor (for others)
5. Refresh button to re-fetch file list (invalidates client cache, forces server re-walk)
6. Status bar: file count, search result count

**Keyboard interaction**:
- Arrow keys navigate results
- Enter copies selected path to clipboard
- Type to filter

### Dotfiles in File-Browser

Add a toggle or query param `?dotfiles=1` to show dotfiles. The server's `GET /api/files` endpoint currently filters `.name.startsWith('.')` — add an optional `dotfiles` query param to skip that filter.

### Copy Path in File-Browser

Add a copy button (📋) to each file entry in file-browser. Click copies the full absolute path to clipboard.

## Server Changes

### `GET /api/files` — dotfiles param
Add optional `dotfiles=1` query param. When present, skip the `.startsWith('.')` filter.

### `GET /api/project-files` — dotfiles param
Add optional `dotfiles=1` query param to `walkProjectFiles`. When present, don't skip dotfile entries.

No new endpoints needed — the existing API covers the use case.

## Considerations

- **Performance**: The `/api/project-files` endpoint already has a 30s TTL cache and 10k file cap. For a docs folder this is more than sufficient. Client-side fuzzy filtering of 10k items is sub-millisecond.
- **Clipboard**: `navigator.clipboard.writeText()` requires secure context (HTTPS or localhost). Caco runs on localhost — works fine.
- **Root param**: The `cwd` param on `/api/project-files` already accepts any absolute path, not just the session CWD. The applet just needs to pass `root` through as `cwd`.
- **File types**: The existing endpoint skips binary files (images, fonts, executables). This is correct for the use case — we want text files to reference.
- **Refresh**: The server caches file lists for 30s. Refresh re-fetches from the server; if the cache is still fresh, results won't change until the TTL expires. This is acceptable — the user can wait a moment and refresh again.
- **Error handling**: Invalid or missing root shows an error message in the applet. Missing root param shows usage hint.

## Acceptance

1. `?applet=file-finder&root=/some/path` opens the applet, loads files, and allows instant fuzzy search
2. Clicking a result copies its absolute path to clipboard with visual feedback
3. Results can be opened in appropriate viewer (markdown-viewer or text-editor)
4. Refresh button re-scans the directory
5. file-browser shows dotfiles when `?dotfiles=1` is in the URL
6. file-browser entries have a copy-path button
7. Keyboard navigation works (arrows + Enter to copy)
