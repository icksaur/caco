# AudioViewer Implementation Review

Scope: `applets/files/audio-viewer.js` (NEW) + wiring in `script.js`,
`source-viewer.js`, `src/config.ts`, `style.css`, `meta.json`, and
`tests/unit/files-applet-audio.test.ts`. Bar: bugs / leaks / correctness only.

## Verdict

Implementation faithfully mirrors `ImageViewer` and matches the spec. No
runtime bugs, leaks, or routing gaps found. One test-quality issue worth fixing
(below). Test suite passes (6/6).

## Evaluation by question

| # | Area | Result |
|---|------|--------|
| 1 | Lifecycle vs ImageViewer | ✅ Correct. Listeners bound once in ctor, removed only in `destroy()` (no per-load leak). `destroy()` idempotent via `destroyed` guard; aborts in-flight via `removeAttribute('src')`+`load()`. Pause-on-deactivate present. `open()` has destroyed-guard after await + container-destroyed guard. Watcher cache-busts (`&t=Date.now()`) + native `audio.load()`. No double-load (open calls `load()` once; watcher onChange the only other caller, and it no-ops after destroy via `if(this.destroyed)return`). |
| 2 | `loaded` flag / `echoState` | ✅ Consistent. Shell (`buildFilesState`, script.js:929) just collects fragments; nothing consumes `loaded` in a way audio diverges from image. Audio omits image-only `zoom`, as designed. |
| 3 | Registry wiring | ✅ Descriptor added before diff/source fallback; `if(AudioViewer)` guard present; `canHandle`/`isDefault` identical regex. Diff/Source `canHandle` = `!isBinaryExtension`, and audio exts are in BOTH binary guards (script.js + source-viewer.js BINARY_RE). A `.wav` cannot reach diff/source. |
| 4 | `error` handler | ✅ Correct & non-duplicating. `_showError` early-returns if `_errorEl` exists; `load()` and `loadedmetadata` both call `_clearError`, so reloads don't stack error divs. |
| 5 | MIME / reverse-lookup | ✅ Acceptable. Three exts map to `audio/ogg` (ogg/oga/opus); reverse-lookup at `api.ts:108` resolves to first match (`ogg`). Only affects generated filenames in the tmpfile-upload endpoint — not `/api/file` serving. Documented in spec; harmless. |
| 6 | Tests | ⚠️ See finding below. |
| 7 | Tab icon / CSS class | ✅ `btn.className = 'fe-tab fe-tab-' + descriptor.viewerType` (script.js:405) → `fe-tab-audio`, matches `.fe-tab.fe-tab-audio` CSS selector. |

## Finding — test gives false parity confidence (Medium)

**File:** tests/unit/files-applet-audio.test.ts:7-45

The `AUDIO_RE`, `SCRIPT_BINARY_RE`, and `SOURCE_BINARY_RE` constants are
**inlined copies** of the regexes, not extracted from the real source files
(only `MIME_TYPES` is imported). Consequences:

- The "binary guards are identical (no silent divergence)" assertion
  (lines 41-44) compares two literals that are identical *by construction in
  the test file*. It is tautological and cannot fail if the real
  `script.js` and `source-viewer.js` guards drift apart — exactly the
  regression the comment claims it prevents.
- Likewise the "reject every audio extension" / "AUDIO_RE matches" tests
  validate the inlined copy, not the shipped descriptor regex.

So the divergence risk the spec calls out ("the two lists must not silently
diverge") is **not** actually guarded.

**Cheap fix:** `readFileSync` the three source files and extract the regex
literals (e.g. match `/\.\(([^)]*)\)\$/i` or the `BINARY_RE =`/`isBinaryExtension`
lines), then assert on the extracted strings. Keeps it DOM-free while making
the parity assertions real.

## Notes (non-blocking, no action needed)

- No DOM harness exists for viewers project-wide; not testing lifecycle here is
  proportionate. The parity-extraction fix above is the only meaningfully
  testable gap.
- `MAX_FILE_SIZE_BYTES` / no Range support / no autoplay all handled per spec.
