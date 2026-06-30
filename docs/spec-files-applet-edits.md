# spec-files-applet-edits

Status: **done** (shipped). Sub-spec of `docs/spec-files-applet.md`. The server-side git
diff-card system + the selection bridge that powers the Files applet's **diff** viewer and
its agent-shared line selection.

## Fit
- Goal it serves: show the user (and the agent) a live diff of in-cwd files — working tree
  vs git HEAD (or staged vs HEAD) — with a persisted, dismissible set of "cards" and a
  line-selection the agent can read and drive.
- Invariants in scope:
  - **Git-backed, in-cwd only.** Every diff path resolves inside the session cwd's git repo
    (`findRepoRoot` at attach; per-request containment re-check against cwd). An external or
    non-git path never reaches this system — the orchestrator routes it to a read-only
    viewer.
  - **Path containment is enforced server-side.** `/file-edits/open` rejects absolute,
    `..`-bearing, NUL-bearing, or cwd-escaping `relativePath` (400) before touching git.
  - **The card list is per-session, schema-versioned, and additively evolved.** Persistence
    is `schemaVersion: 2`; older readers ignore unknown fields; writes are debounced and
    flushable.
  - **A `clean` entry is still a valid card.** A persisted path that is no longer dirty
    returns `status:'clean'` with `fullFile.hunks=[]` (so a reopened-but-unchanged tab
    renders) — not a 404.
- Contradiction check: none. Reuses `GitEditPoller`, the per-session data store, and the
  file watcher.

## Goals
The applet opens a file → server materializes an `EditEntry` (diff payload) → the diff
viewer renders it. A background poller keeps the open cards fresh as the working tree
changes. The user's line selection round-trips to the agent; the agent can push a selection
back. The open/closed/active card set persists across reload and session switch.

## Design

**`GitEditPoller`** (`src/git-edit-poller.ts`). Per-session state, lazily attached to the
cwd's git repo (`findRepoRoot`; `isAttached` reflects whether the cwd resolved to a repo —
the client reads `isGit` to decide diff vs read-only). Key methods (`GitEditPoller`
interface ~345):
- `snapshot(sessionId, cwd?, persistedCleanPaths?) → EditEntry[]` — current dirty set plus
  a synthetic `clean` `EditEntry` for each persisted path not currently dirty. Used on
  applet open to populate without waiting for a poll.
- `openFile(sessionId, relativePath, { diffMode? }) → EditEntry | null` — materialize an
  entry for any in-repo path the user picks; `null` when the path is in neither HEAD nor
  working tree. `diffMode`: `'unstaged'` (default, working tree vs HEAD) or `'staged'`
  (index vs HEAD; staged entries carry `diff` text only).
- `isAttached(sessionId) → boolean`.

**Diff data model** (the `EditEntry` the viewer consumes):
- `EditEntry { path(abs), relativePath, status, diff?, fullFile?, isBinary?, mtimeMs?,
  renamedFrom?, truncated?, timestamp }`.
- `FileStatus = 'modified'|'untracked'|'deleted'|'renamed'|'clean'`.
- `FullFile { headLines: string[]|null, workLines: string[], hunks: DiffHunk[] }` — the V2
  full-file payload the viewer renders (null `headLines` = untracked; empty `workLines` =
  deleted; clean = `hunks:[]`, `workLines==headLines`). Omitted (fall back to unified
  `diff` text) for binary, deleted, or files past `FULLFILE_LINE_CAP`.
- `DiffHunk { headStart, headLen, workStart, workLen }` (1-indexed).

**Card store** (`src/file-edits-store.ts`, `SCHEMA_VERSION = 2`). Per-session persisted
`CardList { schemaVersion, updatedAt, cards: CardPersist[], dismissed: string[] }`. A
`CardPersist` is `{ relativePath, defaultViewerType?, activeViewerType?, diffMode?,
collapsed? }` (`collapsed` vestigial; `diffMode` `unstaged|staged`; the dropped V6 `range`
mode is gone). Writes are debounced per session (`getCardList`/`setCardList`/`flushSession`/
`flushAll`/`cancelCardPersist`); `getCardList` returns the empty shape for a missing/corrupt
file.

**Routes** (`src/routes/file-edits.ts`, mounted under `/api/sessions/:sessionId/
file-edits`). All call `ensureSession` (404 if the session has no cwd):
- `GET /snapshot` → `{ edits: EditEntry[], isGit }` (poller snapshot + persisted-clean
  merge).
- `POST /open` `{ relativePath, diffMode? }` → `{ edit }` — the validated open path
  (containment + diffMode checks above); 400 on bad path, 404 if not in HEAD or working
  tree.
- `GET /cards` → the persisted `CardList`.
- `PUT /cards` `{ schemaVersion, cards, dismissed }` → persists (server stamps `updatedAt`);
  the applet's debounced persist + `sendBeacon`-on-unload target this.

**Selection bridge** (client, `applets/files/script.js` ~976–1390). The diff body lays out
`.fe-row[data-work-line]` rows. A user drag → `envelopeFromRange` snaps the DOM range to
work-line bounds → `{ start, end, text }` (`text` capped 4096) echoed to the agent as
`fileEdits.selection`. An agent-pushed `{ start, end }` → `applyEnvelopeAsRange`
re-materializes a DOM selection, guarded by `_expectedEnvelope` (prevents the programmatic
selection from re-echoing as a user gesture) and `sourceId` (prevents a peer client's echo
from stealing focus).

**Freshness.** The file watcher (`src/file-watcher.ts`) + the poller keep open cards
current; the diff viewer has no file watcher of its own — the orchestrator calls
`update(newEdit)` on it after a poll. Dismissed paths suppress re-creation of a
user-closed tab unless the content changed.

## Considerations
- **Containment is defense-in-depth.** The poller resolves `repoRoot` internally, but the
  route re-checks against cwd (a tighter bound for subdir sessions); both must agree.
- **Clean ≠ absent.** Returning a `clean` entry (not 404) for a persisted-but-unchanged
  path is what lets a reopened tab render; dropping this regresses tab persistence.
- **Full-file vs unified fallback.** Large/binary/deleted files omit `fullFile` and the
  viewer renders the unified `diff` string — the viewer must handle both shapes.
- **Staged mode carries `diff` only** (no `fullFile`); the viewer renders the unified text
  for staged cards.

## Acceptance
- Observable: opening an in-cwd modified file shows its diff (working tree vs HEAD); staging
  + opening with `diffMode:staged` shows index vs HEAD; editing the file updates the card;
  closing dismisses it (and the poll doesn't resurrect it); the open card set + active +
  diffMode survive reload and session switch; a non-git cwd reports `isGit:false` and the
  applet falls back to read-only. A user line-drag reaches the agent; an agent selection
  paints in the UI.
- Budgets: `FULLFILE_LINE_CAP` (omit fullFile above it), debounced card persist, poll
  interval per the poller.
- Gates: `npm run build` green.
- Oracles:
  - git diff helpers (`parsePorcelain` statuses/renames/copies/spaces, `truncateDiff` cap,
    `parseHunks`) → `tests/unit/git-edit-poller.test.ts`. **These are pure parsers** — the
    poller's `snapshot`/`openFile`/clean-entry synthesis/containment/`fullFile` build are
    **not** unit-tested (by-construction).
  - card store **V5→files-cards migration + missing-key/idempotency** →
    `tests/unit/file-edits-store.test.ts`. The debounced `set`/`flush`/`cancel` and
    corrupt-file handling are **not** unit-tested (by-construction).
  - route validation (path rejection, diffMode, ensureSession, clean-merge), the diff
    render, and the selection bridge are **by-construction / visual** — there are no
    `/file-edits/*` route tests today. Extract + test the path-containment check and the
    envelope-snap helper if they change.

## Plan
Shipped across file-edits V2–V6.1. Forward work hangs off:

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Poller: attach, snapshot, openFile, fullFile build, statuses | `src/git-edit-poller.ts` | `git-edit-poller.test.ts` (parse/truncate/hunk helpers); snapshot/openFile by-construction | git-backed in-cwd; clean≠absent |
| 2 | Card store: schema v2, debounced persist, flush | `src/file-edits-store.ts` | `file-edits-store.test.ts` (V5 migration/missing); set/flush by-construction | per-session; additive schema |
| 3 | Routes: snapshot/open/cards with containment + diffMode validation | `src/routes/file-edits.ts` | by-construction (no route test yet); path checks inline | path containment; ensureSession |
| 4 | Client diff render + selection bridge | `applets/files/diff-viewer.js`, `script.js` | visual acceptance | echo guard + sourceId |
