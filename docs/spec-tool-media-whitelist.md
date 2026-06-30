# Spec: Replace `embed_media` with whitelisted markdown media

Status: done

## Goals
Delete the `embed_media` tool (and its server-side oEmbed fetch). Let the agent embed
media by writing ordinary markdown; the **client** turns whitelisted media URLs into
iframes built from fixed, per-provider templates. The domain whitelist — not a remote
oEmbed response — is the trust boundary.

## Why
- `embed_media` is one tool call + a round trip for something the agent can express as
  text. It is already in `DEFAULT_DISABLED_TOOLS`-adjacent "rare in coding" territory.
- The current path fetches provider HTML via oEmbed (`src/oembed.ts`) and injects it
  with `DOMPurify.sanitize(..., { ADD_TAGS: ['iframe'] })` (`public/ts/dom-regions.ts`).
  Trusting provider-returned HTML is a wider surface than we need.

## Design
**Trigger (agent-facing).** A fenced block, parallel to `caco-actions`:
````
```caco-embed
https://www.youtube.com/watch?v=ID
```
````
One URL per line; 1–N lines. Chosen over "bare URL on its own line" because it is
explicit (no false-positive auto-linking) and trivially detectable mid-stream.

**Transform (client-side).** A pure function `mediaEmbed(url): { src: string; kind } | null`:
1. Parse the URL with the `URL` API (rejects `javascript:`/`data:` and malformed URLs).
2. Match `url.hostname` against an **exact-host allowlist** (no suffix matching — block
   `youtube.com.evil.com`). Allowed → YouTube (`youtube.com`, `www.youtube.com`,
   `youtu.be`), Vimeo (`vimeo.com`, `player.vimeo.com`), Spotify (`open.spotify.com`).
   **SoundCloud and Twitter/X are excluded**: neither has a clean id→fixed-template
   embed. SoundCloud's player requires passing the source URL
   (`https://w.soundcloud.com/player/?url=…`) rather than an extracted id, so it does not
   fit the "no pass-through" rule; defer it (a render-time link is the fallback).
3. Extract the id/path and build the iframe `src` from a **fixed template** per provider
   (e.g. `https://www.youtube.com/embed/${id}`). Never pass through query/host from input
   beyond the validated id.
4. Return `null` for anything unmatched → the markdown renderer leaves it as a normal
   link (no embed, no error).

The renderer builds the `<iframe>` element **directly in code** (sandbox attr, fixed
allowlisted `src`) — it does NOT add `iframe` to the DOMPurify tag allowlist, so no
model- or provider-authored iframe can ever pass. `caco-embed` blocks are stripped from
the sanitized text the same way `caco-actions` is, **including the streaming partial-fence
case**: hiding must match an OPEN/incomplete fence mid-stream
(`language.startsWith('caco-embed')` in `markdown-renderer.ts:98-103`, plus the separate
incomplete-fence streaming logic at `~241-247`) so a half-typed block never flashes raw.

**CSP.** The server `Content-Security-Policy` `frame-src` (`server.ts`, ~line 83) must
allowlist the embed hosts (`www.youtube.com`, `player.vimeo.com`, `open.spotify.com`);
without it the iframes are blocked. The current policy lists `w.soundcloud.com` — remove
it with SoundCloud, add the three template hosts.

## Considerations
- Server stays out of it: delete `src/oembed.ts`, `src/display-tools.ts`, the
  `embed_media` registration/import in `server.ts`, and the `embed_media` entry in
  `DEFAULT_DISABLED_TOOLS`. Remove the now-dead `caco.embed` event end-to-end and its
  `storeOutput` `type: 'embed'` usage. **`caco.embed` has more consumers than the render
  path** — all must go together:
  - history replay (`src/routes/websocket.ts:~404-490`)
  - event queue + type alias (`src/caco-event-queue.ts:~14-58`)
  - DOM mappings + embed fetch/render (`public/ts/dom-regions.ts:~119-178, ~314-353,
    ~577-658`)
  - tests: `tests/unit/embed-history.test.ts`, `caco-event-queue.test.ts:~10-92`,
    `event-filter.test.ts:~150-170`, `session-runtime.test.ts:~16-35`,
    `tool-registry.test.ts:~10-30`, and the `caco.embed` cases in
    `sdk-normalizer.test.ts`/`sdk-event-parser.test.ts`.
- No network calls at embed time → no titles/authors. Acceptable; the link text carries
  context. Thumbnails are dropped.
- Twitter/X and SoundCloud are dropped (no clean fixed-template iframe; oEmbed/player-URL
  only). If wanted later, add as a render-time link/blockquote, not a templated iframe.
- The system-prompt "Media embeds" capability line and `embed_media` mentions must be
  reworded to describe the `caco-embed` fence.

## Acceptance
Oracle = `mediaEmbed` is a pure URL→src mapping; test by **independent reimplementation**
in a table, compared against real output:
- Each provider: canonical + alternate host (`youtu.be`, `player.vimeo.com`) → expected
  fixed `src`. (reference table)
- Non-whitelisted host (`example.com`, `youtube.com.evil.com`) → `null`. (hand cases)
- `javascript:`/`data:`/garbage → `null`, no throw. (hand cases)
- Rendering a `caco-embed` block yields an `<iframe>` whose `src` ∈ template set and
  whose host ∈ allowlist; a non-whitelisted block yields a link, never an iframe.
  (invariant over rendered DOM)
- Full gate green after the server-side deletions.

## Plan
1. Add `public/ts/media-embed.ts`: exact-host allowlist + per-provider id extractor +
   `mediaEmbed(url)` returning a fixed-template `src` or `null`.
2. Write `tests/unit/media-embed.test.ts` (the reference table + hand cases) FIRST.
3. Hook the `caco-embed` fence in `markdown-renderer.ts`: strip the fence from sanitized
   text (match OPEN/partial fences mid-stream as `caco-actions` does); for each line call
   `mediaEmbed`; build the `<iframe>` (sandboxed, fixed src) or fall back to a link. Do
   not widen DOMPurify tag allowlist.
4. Update CSP `frame-src` in `server.ts` (add the three template hosts; drop
   `w.soundcloud.com`). Delete `src/oembed.ts`, `src/display-tools.ts`; remove
   `embed_media` import/wiring in `server.ts` and its `DEFAULT_DISABLED_TOOLS` mention.
5. Remove the dead `caco.embed` event END TO END — websocket replay
   (`websocket.ts`), event queue/type alias (`caco-event-queue.ts`), client DOM
   mappings + embed-output fetch path + `embed_media` special-case (`dom-regions.ts`),
   `type:'embed'` store usage — and delete the listed tests
   (`embed-history`, `caco-event-queue`, `event-filter`, `session-runtime`,
   `tool-registry` embed cases, normalizer/parser `caco.embed` cases).
6. Reword the system-prompt media capability line to the `caco-embed` fence.
7. Run `npm run build`; fix fallout.
