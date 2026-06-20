# Files Applet Audio Viewer Spec Review

Quality bar: correctness + maintainability; low-risk mirror of ImageViewer, so only material issues below.

## Findings

| Severity | Area | Finding | Recommendation |
|---|---|---|---|
| Must fix | Binary guards | Spec updates `script.js:isBinaryExtension()` but misses `applets/files/source-viewer.js:BINARY_RE`. Today `SourceViewer` has its own binary guard. This matters for external fallback/error paths and keeps two binary lists silently out of sync. | Add audio extensions to `BINARY_RE` too, or better, note the duplication and add a test that both guards reject audio. |
| Must fix | Audio reload lifecycle | `load()` says to set `audio.src = ...&t=...`, but for a reused `<audio>` element, the reliable reset/re-fetch sequence is set/remove `src` then call the element’s native `audio.load()`. Without `audio.load()`, watcher reload/reset behavior can be browser-dependent. | Specify `this.audio.src = url; this.audio.load();` on initial load and watcher reload. Also call `load()` after clearing/removing `src` in `destroy()` if the implementation reuses one element. |
| Should fix | Listener lifecycle | Spec says track `loaded` via `loadedmetadata` / `error`, and destroy removes media listeners, but does not say whether listeners are installed once or per `load()`. Per-load listeners would leak and double-fire on watcher reloads. | Specify stable bound handlers installed once in constructor and removed in `destroy()`, or explicit remove-before-add in `load()`. Add a watcher-reload unit asserting no duplicate state updates if practical. |
| Should fix | MIME values | Most MIME additions are fine, but `.opus: audio/opus` is questionable for browser file playback; `.opus` files are commonly Ogg Opus and are typically served as `audio/ogg` (optionally with codec metadata, which this route does not set). | Verify target browser accepts `audio/opus`; otherwise map `.opus` to `audio/ogg`. |

## Confirmed OK

- Registry plan is otherwise correct: add `AudioViewer` global lookup/warn, guard descriptor with `if (AudioViewer)`, and register before Diff/Source. The regex should be identical across `canHandle` and `isDefault` and include all listed extensions.
- Ordering requirement is valid: audio must be before the diff/source fallback path and audio extensions must be binary so Diff/Source do not claim them.
- Adding audio extensions to `isBinaryExtension()` only affects Diff/Source descriptor matching in live code.
- `/api/file` behavior is sufficient for scoped small audio: non-text `Content-Type`, `Content-Length`, no charset, no Range. Lack of Range support is correctly called out.
- Reverse MIME lookup at `api.ts:108` is not materially harmed. Duplicate `audio/ogg` would pick the first listed extension for generated filenames, which is acceptable if ordering is intentional.
- Reset-to-start on watcher reload is a reasonable default for regenerated synth output; preserve-position can stay out of scope.
- Acceptance is mostly proportionate. Manual “hear it play, reload, tab switch pauses” is the right high-value check; full Range/large-file streaming is correctly out of scope.
