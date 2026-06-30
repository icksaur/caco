# Files applet — roadmap

The Files applet was built across ~60 version/review docs (V1 tabbed diff/markdown →
V7 one-viewer-per-type, no-session mode; file-edits V2–V6.1 diff cards). Those per-version
specs **diverged from the code** and have been **retired** (June 2026) in favor of a
consolidated, code-accurate spec set. The history lives in git if ever needed.

## Current spec set (source of truth)

| Spec | Covers |
|---|---|
| `docs/spec-files-applet.md` | Root: tabs, viewer switching, path routing (in-cwd vs external), file picker, state/persistence, the selection→agent bridge, server file API. |
| `docs/spec-files-applet-viewers.md` | The viewer contract + per-viewer behavior (source, markdown, diff, image, audio, html; `editable-text` write encoder). |
| `docs/spec-files-applet-edits.md` | The git diff-card system: `GitEditPoller`, the card store, `/file-edits/*` routes, and the line-selection bridge. |

## Shipped history (summary)

| Version | Theme |
|---|---|
| V1 / V1.1 | Tabbed diff+markdown; tab = `TabContainer` holding a `Map<viewerType, ViewerInstance>`; floating viewer toggle. |
| V2–V4 | Image / audio / html / source viewers; picker icons + copy-path; per-type defaults. |
| V5 | Retired stub applets path; deep-link routing. |
| V6 / V6.1 | Staged-diff mode; dropped the range mode. |
| V7 | No-session mode; `files` owns one viewer per type; deleted the per-type stub applets. |

Forward work hangs new Plan rows off the three specs above; this roadmap is no longer a
living per-version tracker.
