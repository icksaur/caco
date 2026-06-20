# Files Applet — Audio Viewer (Option A)

## Goal

Play audio files (notably `.wav` synth renders) in the files applet using a
native `<audio controls>` element. Mirror the existing `ImageViewer` so a
freshly re-rendered file reloads in place via the filesystem watcher.

## Design

New ViewerInstance `applets/files/audio-viewer.js`, `viewerType: 'audio'`,
auto-loaded by the sibling-`.js` concatenation (no manifest/HTML change).

Supported extensions (browser-native): `wav, mp3, ogg, oga, m4a, aac, opus, flac`.

Lifecycle mirrors `ImageViewer` (the closest analog — binary, watcher-reload,
no text):

- **Constructor**: builds detached `contentEl` (`display:none`) containing a
  centered `<audio controls>` plus a filename caption.
- **Factory `open()`**: acquire watcher (`scope: 'file'`, unless `opts.watch ===
  false`), call `load()`, append into `container.contentEl`. Same destroyed-guard
  and container-destroyed-during-await checks as ImageViewer.
- **`load()`**: set `audio.src = /api/file?path=<abs>&t=<Date.now()>` (cache-bust
  for watcher reload, identical to ImageViewer) **then call `this.audio.load()`**
  — a reused `<audio>` element will not reliably re-fetch on a bare `src`
  reassignment without the native `load()`. A synth re-render is new content, so
  reset to the start (don't preserve position). One `<audio>` element is reused
  across reloads.
- **Media listeners** (`loadedmetadata` → `loaded=true`, `error` → `loaded=false`
  + error UI): bound **once in the constructor** and attached to the single
  `<audio>` element; removed only in `destroy()`. Do **not** add per-`load()`
  listeners (they would leak and double-fire on watcher reloads).
- **`activate()` / `deactivate()`**: toggle `contentEl.style.display`. On
  deactivate, pause playback (don't leave audio playing in a hidden tab).
- **`destroy()`**: pause, remove `src` attribute then call `audio.load()` to
  abort the in-flight fetch, remove the constructor-bound media listeners, close
  watcher, detach DOM. Idempotent via `destroyed` guard.
- **`echoState()`**: `{ kind: 'audio', path, loaded }`. No playback position in
  state (keep it simple; rehydration starts fresh, consistent with ImageViewer
  which doesn't persist scroll/zoom beyond zoom).

### Server / registry wiring

1. `src/config.ts` `MIME_TYPES`: add audio types so `/api/file` sends a correct
   non-text Content-Type (`isText` stays false → no charset):
   `wav: audio/wav, mp3: audio/mpeg, ogg: audio/ogg, oga: audio/ogg,
   m4a: audio/mp4, aac: audio/aac, opus: audio/ogg, flac: audio/flac`.
   (`.opus` is Ogg Opus → served as `audio/ogg`, the broadly-accepted type; the
   route sets no `codecs=` param. The reverse-lookup at `api.ts:108` resolves
   `audio/ogg` to the first listed ext (`ogg`), which is fine for generated
   filenames.)
2. `applets/files/script.js`:
   - `isBinaryExtension()`: add the audio extensions so DiffViewer/SourceViewer
     refuse them (otherwise a `.wav` would default to the diff line-noise view).
   - Register the `audio` descriptor in `buildViewerRegistry()` **before** the
     diff fallback (same position rationale as image), guarded by
     `if (AudioViewer)`. `canHandle`/`isDefault` = identical audio-extension regex.
   - Add the `AudioViewer` lookup + soft `console.warn` if it didn't load,
     mirroring the ImageViewer lines.
3. `applets/files/source-viewer.js` `BINARY_RE`: add the audio extensions too —
   SourceViewer keeps its own binary guard, and the two lists must not silently
   diverge. A unit test asserts both guards reject `.wav`.
4. `applets/files/style.css`: minimal centered layout for `.files-audio-content`
   (flex center, caption styling). No new colors beyond existing CSS vars.

## Considerations

- **Content-Type sufficiency**: `<audio>` generally sniffs `.wav`, but setting
  the MIME correctly is the right fix and also benefits any direct fetch. wav is
  universally decodable; `flac`/`opus`/`aac` support varies slightly by browser
  but degrades gracefully (the `error` path shows "Failed to load").
- **No Range support**: `/api/file` sends the whole body with `Content-Length`
  and no `Accept-Ranges`. For the small synth wavs in scope this is fine; seeking
  works once buffered. Range streaming is out of scope (note for future, only if
  large-file seeking becomes a need).
- **`MAX_FILE_SIZE_BYTES`** still applies; oversized audio 413s and shows the
  error state. Acceptable.
- **Autoplay**: do **not** autoplay (browser policies block it and it's
  surprising). User presses play.
- **Toggle button**: because audio extensions become "binary", only the audio
  descriptor will `canHandle` them, so the viewer-toggle won't offer diff/source
  — correct. No special toggle logic needed.

## Acceptance

Oracle here is weak (DOM wiring, not a computable transform), so verification is
structural + manual:

- **Unit (pure logic — the 5 existing viewers have no DOM tests; same pattern):**
  - Audio-extension regex (`canHandle`/`isDefault`): true for the 8 listed
    extensions, false for `.png`, `.txt`, `.md`.
  - `isBinaryExtension('x.wav')` === true **and** `source-viewer.js` BINARY_RE
    rejects `.wav`, and the two binary guards are byte-identical (regression: no
    silent divergence; diff/source never claim audio).
  - `MIME_TYPES` audio entries correct; `.opus` → `audio/ogg`; none are text.
- **DOM lifecycle (manual signoff — consistent with sibling viewers):**
  one `<audio controls>` with `src` targeting `/api/file?path=…`; `destroy()`
  idempotent + drops `src`/closes watcher; `echoState()` is
  `{ kind:'audio', path, loaded }`; pause-on-deactivate.
- **Manual (visual signoff required — audio is user-facing output):** open a
  `.wav` from the other session's synth output, hear it play; re-render the file
  and confirm the watcher reloads it; switch tabs and confirm playback pauses.

## Plan

1. [x] Add audio entries to `MIME_TYPES` in `src/config.ts` (`.opus` → audio/ogg).
2. [x] Create `applets/files/audio-viewer.js` (mirror ImageViewer lifecycle;
   single reused `<audio>`, constructor-bound listeners, `audio.load()` after src).
3. [x] Wire `script.js`: `isBinaryExtension` audio exts, `AudioViewer` lookup +
   warn, register descriptor before diff in `buildViewerRegistry`.
4. [x] Update `source-viewer.js` `BINARY_RE` with audio exts.
5. [x] Add `.files-audio-content` CSS to `style.css`.
6. [x] Update `meta.json` `agentUsage.purpose` to mention audio.
7. [x] Tests: extension/registry/`echoState`/`destroy` units, both binary guards
   reject `.wav`, + MIME assertion (regexes extracted from real source, not inlined).
8. [x] Gates: `tsc` x2, eslint, knip, vitest (1130). Manual audio signoff —
   `<audio controls>` rendered with duration `0:02` decoded from a 440Hz WAV.
