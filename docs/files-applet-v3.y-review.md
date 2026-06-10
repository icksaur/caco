# Files applet V3.y — spec review

Reviewer pass against `docs/files-applet-v3.y.md` (draft). Findings
tiered BLOCKER / IMPORTANT / NICE-TO-HAVE. Each finding cites spec
section + concrete code location.

## BLOCKERs (must address before impl starts)

### B1. Ctrl+P is **already bound** globally — spec ignores it

`public/ts/input-router.ts:63-71` already implements:

```ts
if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
  e.preventDefault();
  const cwd = getViewState() === 'newChat'
    ? (getNewChatCwd() || getCurrentCwd() || '~')
    : (getCurrentCwd() || '~');
  window.location.href = '/?applet=file-finder&root=' + encodeURIComponent(cwd);
  return;
}
```

The spec's §4.2.A presents Ctrl+P binding as new and shows an
`addEventListener` snippet that would be a SECOND handler. The
current handler must be **replaced** (not stacked) and `§4.2.A` must
say so explicitly. Additionally, the existing handler does a
**full-page navigation** via `window.location.href` (so the loaded
page is fresh). The proposed `nav.navigate(...)` SPA navigation is a
different code path — call this delta out and confirm `nav.navigate`
(presumably `router.ts`'s exported navigate) is the right entry point.

Action: rewrite §4.2.A to (a) point at the existing handler, (b)
explain the replacement strategy (delete the legacy `file-finder`
launch, install the new `file-edits&openFinder=1` launch), (c) decide
what happens to the `Ctrl+Shift+F` session-search peer for consistency
(unchanged is fine but state it).

### B2. `'finder-shortcut'` is not a valid panel-state `Reason`

`public/ts/panel-state.ts:24-29` defines `Reason` as a **closed
union**: `'init' | 'user-toggle-session' | 'user-toggle-applet' |
'user-session-pick' | 'deep-link'`. The spec's §4.2.A
`getPanelState().set({ applet: true }, 'finder-shortcut')` will not
compile.

Either (a) extend the `Reason` union with `'finder-shortcut'` (and
update the doc comment), or (b) re-use `'deep-link'` since the
mechanism is in fact a deep-link navigation. Recommend (a) because
it improves debug signal and matches the spirit of `Reason` ("why
did this happen?").

### B3. File-edits applet does NOT currently wire `onUrlParamsChange`

Spec §4.1.B says: *"the existing `appletAPI.onUrlParamsChange` is
wired in V1 only for chrome purposes"*. Grep of
`applets/file-edits/script.js` for `onUrlParamsChange` returns
**zero matches**. The wiring is new in V3.y.1; the spec must say
so (and confirm there is no existing handler to merge into).

Tangentially: the applet does register `onSessionChange`,
`onSessionEvent`, and `onStateUpdate` (lines 2704-2721), so the
registration site for the new handler is obvious — just call out
where it lives.

## IMPORTANT

### I1. Race between `openPath` arrival and `cachedCwd` load

`cachedCwd` is populated asynchronously via `getSessionMeta` (lines
2774-2780) or via `onSessionChange` (line 2765). On a fresh load,
`onUrlParamsChange` fires **immediately** with current params
(`applet-runtime.ts:378`), which may be **before** `cachedCwd` is
set. Spec's `relativizePath` helper (§4.1.B) returns the path as-is
when `cachedCwd` is empty, and `routeOpen → absPathOf` (line 1908)
falls back to using the input as both rel and abs.

Effect: if a user lands on `?applet=file-edits&openPath=/repo/x.md`
on cold load, the tab may be created with the full absolute path as
its "relative path", duplicating logic / breaking
`findContainerByRelPath` dedup if the same file is later opened by
the picker (which uses true relPath).

Fix options to consider in spec:
1. Queue `openPath` until `cachedCwd` is set (await session init,
   then drain).
2. Document the absolute-path branch as the supported fallback and
   teach `findContainerByRelPath` / `routeOpen` to normalise abs↔rel
   when `cachedCwd` is known.

Recommend (1) — small queue is simpler than reasoning about dual
identity. Either way, the spec needs a §4.1.B subsection on this.

### I2. `openFinder=1` in newChat (no session) is unspecified

`file-edits` requires a session — its picker fetches
`/api/project-files?cwd=` and `pickerFetchToken` early-returns when
`!sessionId` (line 1853). Ctrl+P from the newChat view (no active
session yet) has no cwd to scope the finder, but the existing
input-router today handles this branch (uses `getNewChatCwd()` for
the legacy file-finder).

Spec §4.2 must decide:
- A. Disable Ctrl+P in newChat (keep legacy behaviour or no-op).
- B. Open finder rooted at `getNewChatCwd()` somehow — but
  file-edits has no UI for "rooted, no session".
- C. Fall back to the standalone `file-finder` applet in newChat;
  switch to in-applet finder once a session exists.

Recommend (C) as least surprising; document in §4.2.A.

### I3. `navigateAppletUrlParam(key, value)` signature mismatch

`applet-runtime.ts:346` types it as `(key: string, value: string)`
with a falsy-deletes branch (`if (value)`). Spec §4.1.A and §4.1.B
call `navigateAppletUrlParam('openPath', null)`. Applets are .js so
TS won't catch it at the call site, but the contract is informal at
best — passing `null` works today only because the implementation
truthy-checks. Either:
- Widen the signature to `value: string | null` and document the
  consume-on-parse pattern, OR
- Have the spec pass `''` instead of `null`.

Pick one explicitly; this is the API the spec depends on.

### I4. §4.1.D `getApplet` refactor — return-shape change is not noted

The proposed function returns `{ slug, param }`, but today
`getApplet` returns a bare string consumed at lines 179/211 as
`?applet=${getApplet(name)}&path=...`. Every call-site needs the
matching refactor (`?applet=${a.slug}&${a.param}=...`). The spec
shows the helper but not the call-site change. Also: since every
arm returns the same object, the helper now reduces to a
constant — collapse it inline or delete it entirely.

### I5. §7.3 capture-phase recommendation contradicts existing code

§7.3 row 1 recommends `addEventListener('keydown', handler, true)`
(capture phase) to beat the browser's print dialog, claiming the
existing input-router uses bubble. The existing Ctrl+P handler on
bubble (`input-router.ts:38`) already works — preventDefault on the
document-level bubble listener fires before the browser's default
action because the default runs after the JS event finishes
propagating. There is no precedent or need for capture; remove the
recommendation. If you want defence-in-depth, document it as
"bubble has been verified sufficient; switch to capture only if a
future regression appears."

### I6. Existing `Ctrl+P` in input-router is bubble; works today

(Companion to I5.) The existence proof that bubble suffices: the
current handler already calls `e.preventDefault()` on bubble and
suppresses Print in production. The spec's risk row overstates the
problem.

## NICE-TO-HAVE

### N1. `>img` filter syntax: also accept `>img:foo` / `>img/foo`

Spec §4.2.E regex `/^>(img|md|html|diff|any)\s+(.*)$/` requires
whitespace. `>img` with no trailing space silently no-ops. VS Code
accepts both `>cmd ` and `>cmd<input>` boundaries. Suggest:
`/^>(img|md|html|diff|any)(?:[\s:/]|$)(.*)$/` so `>img`,
`>img foo`, `>img:foo`, `>img/foo` all work. Cheap polish.

### N2. Recent-files mixes paths across projects (cross-cwd)

Spec §7.4 Q2 acknowledges this is acceptable. Tighten the user-
visible effect: when the finder lists recent files from a different
cwd, the row's basename collides ambiguously (`README.md` from
project A and B look identical). Mitigation: render the cwd suffix
beside the row (e.g. `README.md  ·  ~/repo/other`), OR scope the
storage key per cwd (`caco:files-applet:recentPaths:<cwdHash>`).
Either way, document the chosen UX in §4.2.D.

### N3. Fuzzy scoring port — single source

§4.2.F copies `fuzzyScore` from `applets/file-finder/script.js`.
The spec already flags V4 cleanup. Land the function in a shared
location now (e.g. `applets/_shared/fuzzy.js` or co-locate with
file-edits and have file-finder consume it via concat) so V4's
cleanup is a delete-applet, not a delete-applet-and-reconcile-two-
implementations.

### N4. `openLine` / cursor positioning is out of scope but undocumented

Spec §3 should add a one-liner: "no `openLine`/`openColumn` — open
at top of file. Deferred to a future spec when needed." Saves a
predictable open-question round-trip in review.

### N5. Deep-links from external tools (terminal `xdg-open`)

Spec §2 use cases is chat-flavoured. Add U8: "External tool opens
`https://caco.local/?applet=file-edits&openPath=/abs/foo.md`. The
URL contract supports this since `openPath` is documented and
session-independent (uses the active session's cwd)." Makes the
external-integration angle explicit and motivates the §4.1.A
contract.

### N6. Type filter list missing common types

`>img|md|html|diff|any` omits source code (`>code` → ts/js/py/...),
JSON (`>json`), text (`>txt`). Not blocking; could ship V3.y.2 with
the documented five and add more later. Worth a sentence in §4.2.E
explicitly listing what's NOT included so reviewers don't keep
asking.

### N7. Esc focus restore — be explicit about chat input case

§4.2.C says Esc "restores focus to the previously-focused element."
If Ctrl+P was triggered while typing in the chat composer, restoring
focus there is desired. But Caco's input-router also treats Esc as
the **leader key** (`input-router.ts:53-61`) — Esc starts a 500ms
leader window for `l` / `.` / `,` shortcuts. The finder's Esc must
**not** propagate to the input-router's leader timer, or pressing
Esc to close the finder will arm the leader and the next keystroke
will be interpreted as a leader follow-up. Spec needs a sentence:
"finder's Esc handler calls `stopPropagation()` so the leader timer
is not armed."

### N8. Preview-on-hover deferral is correct

§3 defers preview-on-hover to V3.y.3+. V3.y.2 already adds fuzzy +
recent + type-filter + cross-applet Ctrl+P entry; that's enough
scope. The deferral is the right call — confirm and move on.

### N9. `code-quality.md` cross-check

- "only one way to do one thing" — V3.y.1 keeps both
  `?applet=markdown-viewer&path=X` AND `?applet=file-edits&openPath=X`
  working. This is intentionally transitional; spec §6 documents
  the V4 cleanup. Acceptable for one release; flag in §10 that V4
  must close this.
- "code is a liability" — V3.y.2's port of `fuzzyScore` (see N3)
  creates a second copy. Don't.
- "wrong abstraction" — §4.1.D's `getApplet` returning a constant
  object after the refactor is pure dead weight; collapse to a
  string literal at the call site (see I4).
- "complexity / coupling" — the `openFinder=1` URL param couples
  router state to applet-internal UI. Acceptable because it
  mirrors `openPath`, but consider whether a session-meta flag or
  a direct API (`appletAPI.openFinder?()`) would be cleaner. For
  V3.y, URL-param is fine and consistent.

## Summary

Three blockers, all about the spec being out-of-date with the
current codebase: existing Ctrl+P binding (B1), `Reason` union
membership (B2), and the missing-not-existing `onUrlParamsChange`
wiring (B3). Six importants are mostly tightening contracts
(cwd-load race, newChat behaviour, signature alignment). Nice-to-
haves are polish.

Recommended order: fix blockers in spec → re-review just B1+B2+B3
diffs → start V3.y.1 implementation. V3.y.2 spec is fine to defer
its impl-prep review until V3.y.1 ships.
