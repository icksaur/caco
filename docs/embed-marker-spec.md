# Spec: `embed_media` → `caco-embed` inline marker (A3-style)

## Goal

Replace the `embed_media` **tool** with an inline parsed marker, exactly as A3 replaced
`caco_offer_action` with the ```` ```caco-actions ```` trailer. The agent writes a fenced
block; the server parses it out of the final assistant message, performs the oEmbed fetch,
and drives the **existing** `caco.embed` render path. This removes a tool from every
session's schema (its name + description + URL-param schema, on every turn) **and** removes
a model round trip per embed.

Net-additive bonus: `embed_media` currently sits in `DEFAULT_DISABLED_TOOLS`
(tool-registry.ts) — embedding is OFF by default today. The marker re-enables embedding
with **zero** per-turn tool cost.

**Honest scope note (post-review):** this is shaped like A3 but is genuinely *larger*. A3
persisted a single session-meta field; embeds emit a **live event that must also survive
history replay**, so the real work is a persisted, deterministically-keyed, replayable embed
record plus a guarded async oEmbed effect — not just a parse + a meta write. The savings
(one fewer schema tool every turn, one fewer round trip per embed) are real, but this is a
multi-slice change, not a trivial swap.

## Why this is low-risk… and the one place it is NOT (replay)

The **live** embed render path is already event-driven: `caco.embed` event → an
`embed-message` region element (dom-regions.ts) → `fetchAndRenderEmbed(element, outputId)`
fetches `/api/outputs/:id` and injects the DOMPurify-sanitized iframe. The current tool just
emits that event.

But there is a **second half** the first draft missed: **history replay**. On
reload/reconnect, the client is not subscribed when a live event fired; today embeds survive
because they are persisted as `type:'embed'` outputs and `streamHistory` reconstructs
`caco.embed` from those persisted outputs + the `[output:xxx]` markers in the transcript.
`broadcastEvent` is **live-only**. Therefore a naive "fire `caco.embed` from an async
fire-and-forget effect" design **drops embeds** for any client not currently subscribed and
loses them entirely on reload. The marker design MUST define a persisted, deterministically
re-constructable embed record and a replay path — this is the core of the design, not an
afterthought (see "Persistence & replay" below).

## Current mechanism (to retire)

- `src/display-tools.ts` `createDisplayTools(storeOutput, emitCacoEvent)` defines
  `embed_media`: `detectProvider(url)` → `fetchOEmbed(url)` → `storeOutput(html, {type:'embed',…})`
  → `emitCacoEvent({type:'caco.embed', data:{outputId, provider, title}})` → returns
  `[output:${outputId}] …` text.
- `src/routes/websocket.ts` ALSO re-parses `[output:xxx]` markers from tool results
  (`parseOutputMarkers` + `embedLookup`) and queues `caco.embed` — a second path that exists
  only because the tool result text carries the marker.
- Client: `dom-regions.ts` maps `caco.embed` → `embed-message` element →
  `fetchAndRenderEmbed`. `oembed.ts` provides `detectProvider`, `fetchOEmbed`,
  `getSupportedProviders`. `output-store.ts` provides `storeOutput`/`getOutput`.

## A3 mechanism (to mirror)

- `src/offer-action-parse.ts` `extractActionOptions(message)`: a regex over the **final**
  assistant message extracts a fenced block; `normalizeOptions` caps/trims.
- `src/dispatch-events.ts` on `assistant.message`: calls `extractActionOptions(content)` and
  writes `meta.responseOptions` (a pure, sync side-effect).
- `public/ts/markdown-renderer.ts` `code()`: returns `''` for an info-string starting with
  `caco-actions`, hiding the block in the transcript (open or closed).
- `public/ts/streaming-markdown.ts` `stripStreamingActionBlock(raw)`: during streaming,
  suppresses a *forming* (unclosed/partial) trailer so it never flashes.

## Design

### Marker shape

````
```caco-embed
https://www.youtube.com/watch?v=dQw4w9WgXcQ
```
````

One URL per line; a block MAY contain multiple URLs (multiple embeds). Unlike
`caco-actions`, the block is **NOT** a final-trailer — embeds can appear anywhere and more
than once in a message (e.g. "here's the talk […] and the follow-up […]").

### Parsing (`src/embed-marker-parse.ts`, new — mirrors offer-action-parse.ts)

- `extractEmbedMarkers(message: string): { url: string; occurrence: number }[]` — find all
  **top-level, closed** ```` ```caco-embed ```` fences and return each body URL with a
  per-message **occurrence index** (for stable keying; see replay).
- **Top-level only:** a ```` ```caco-embed ```` sample nested inside another fenced block
  (docs often use a longer outer fence) MUST NOT match. Track fence depth / outer-fence
  spans and reject matches inside them — a bare "find all fences" regex is insufficient.
- **Strict URL lines:** each non-blank body line, after trim, must parse via `new URL()` with
  protocol `http:`/`https:`; anything else is dropped (not treated as a URL).
- Dedupe identical URLs **within the message** (keep first occurrence); do NOT dedupe across
  the session (the same URL may be intentionally embedded again in a later turn).
- Handle CRLF (`\r?\n`), blank/whitespace lines, an empty block (→ none), and a mix of
  supported + unsupported URLs (unsupported handled later by `detectProvider`).
- Cap at `MAX_EMBEDS` (e.g. 6). Pure + exported for unit testing.

### Persistence & replay (the load-bearing addition)

An embed is identified by a **stable, deterministic key**:
`embedKey = sessionId + ':' + assistantMessageId + ':' + normalizedUrl + ':' + occurrence`.

- On the final `assistant.message`, for each parsed marker, compute `embedKey`. If an embed
  output for that key already exists, **reuse it** (idempotent — a re-delivered message or a
  re-parse never creates a duplicate or a new random `outputId`). Otherwise
  `detectProvider` → `fetchOEmbed` → `storeOutput(html, { type:'embed', embedKey,
  assistantMessageId, url, provider, occurrence, … })`.
- **Live:** emit `caco.embed` (via `deps.onEvent`) once the output exists. Because oEmbed is
  async, the embed appears **shortly after** its message rather than at a guaranteed
  pre-message position. This is an accepted, documented behavior change from the tool (which
  flushed before `assistant.message`); it is cosmetic and only affects the first live render,
  never replay.
- **Replay:** `streamHistory` reconstructs `caco.embed` from the persisted `type:'embed'`
  outputs, ordered by `assistantMessageId` then `occurrence`, so reload/reconnect renders
  every marker embed deterministically — replacing the old `[output:xxx]`-marker
  reconstruction. **Old sessions:** keep the existing `[output:xxx]` replay path for
  backward compatibility (pre-existing embeds carry those markers); the new path is additive.

`assistantMessageId` must be available on the `assistant.message` event; if it can ever be
absent, specify a fallback key (e.g. a content hash + occurrence) and test duplicate delivery.

### Server trigger (`src/dispatch-events.ts`, on `assistant.message`)

Add an embed branch beside the `caco-actions` branch. **Wrinkles, both addressed:**

1. **Async in a sync function.** `applyDispatchEventEffects` is sync; oEmbed is async. Use a
   fire-and-forget `void embedFromMessage(...)` helper that is **fully guarded** — each URL in
   its own `try/catch`, an `AbortSignal` timeout on `fetchOEmbed` (it has none today), so one
   slow/failed URL neither rejects unhandled nor blocks later URLs nor does unbounded work
   after dispatch ends.
2. **Missing `sessionCwd`/store access.** `storeOutput(sessionId, sessionCwd, data, metadata)`
   needs `sessionCwd`, which `applyDispatchEventEffects` does not receive. Extend
   `DispatchEventDeps` with an injected `storeEmbedOutput(key, html, meta) → outputId`
   (idempotent by key) rather than importing `storeOutput` + threading paths into the effects
   layer — keeps dispatch decoupled from storage/path details.

```
void embedFromMessage(sessionId, messageId, content, deps):
  for each { url, occurrence } of extractEmbedMarkers(content):
    try:
      if !detectProvider(url): log+skip            // allowlist BEFORE any fetch
      const key = embedKey(sessionId, messageId, url, occurrence)
      const outputId = deps.storeEmbedOutput.existing(key)
                    ?? deps.storeEmbedOutput(key, await fetchOEmbed(url, { signal: timeout }), meta)
      deps.onEvent({ type:'caco.embed', data:{ outputId, provider, title } })
    catch e: log structured telemetry; continue    // never throws out of the helper
```

Parse only on the **final** `assistant.message` (not deltas).

### Client: hide the marker in the transcript

- `markdown-renderer.ts` `code()`: extend the existing guard — also return `''` when the
  info-string is `caco-embed` (or `startsWith('caco-embed')`), so the fence never renders as
  a code block. The embed appears via its `caco.embed` event element, exactly as today.
- `streaming-markdown.ts`: during streaming, suppress forming `caco-embed` blocks so a
  half-typed ```` ```caco-embed `` + URL never flashes as a code block. **The A3 helper does
  NOT generalize:** `stripStreamingActionBlock` assumes a single **final** trailer, but a
  `caco-embed` block can appear mid-message, repeat, and be followed by more prose. Define a
  new pure transform `stripStreamingEmbedBlocks(raw)` that removes **all top-level
  `caco-embed` blocks — closed or unclosed — while preserving surrounding prose** (the
  closed-block case still also gets dropped by `code()` at full render; the streaming strip
  prevents the flash in `.streaming-tail` before that render). Keep both helpers pure +
  tested; factor any shared fence-scanning into a common primitive.

### Removal

- Delete `embed_media` from `src/display-tools.ts` and `createDisplayTools` (the file has no
  other tools). **Move** the `CacoEmbedEvent`/`CacoEvent` type(s) out of `display-tools.ts`
  to a neutral home (e.g. the event-bus/types module) since other code imports them.
- Drop the `createDisplayTools` wiring at its only call site (`server.ts` ~242-245, plus the
  import) that passes `storeOutput`/`emitCacoEvent`.
- Remove the `embed_media` **client completion special case** in `dom-regions.ts` (~577-584,
  "embed_media completion is handled by caco.embed event").
- Remove the `embed_media` entry from `DEFAULT_DISABLED_TOOLS` (tool-registry.ts).
- `websocket.ts` `[output:xxx]` path (`parseOutputMarkers`/`embedLookup`/`listEmbedOutputs`,
  ~21/357-425): it bridged tool-result text → `caco.embed` and reconstructed history embeds.
  The marker design supplies its own persisted replay (above). **Keep this path for
  backward-compatible replay of OLD sessions** whose transcripts still contain `[output:xxx]`
  markers; it is simply no longer fed by a live tool. (Removing it would break embeds in
  pre-migration sessions — out of scope.) Confirm no *other* live producer depends on it.
- Update `dev-docs-tool.ts` reference to `embed_media`.

## Considerations

- **Live vs replay parity.** The embed renders via the same `caco.embed` event,
  `embed-message` element, `fetchAndRenderEmbed`, DOMPurify chain, and `/api/outputs/:id`.
  The one accepted change: the live embed appears **shortly after** its message (async
  oEmbed) rather than flushed just before it; **replay order is deterministic** (by
  `assistantMessageId` then `occurrence`).
- **Lost tool return = lost failure signal.** The tool could tell the agent "unsupported
  URL." A marker can't (no round trip — that's the saving). Per-URL policy: an unsupported
  URL (`!detectProvider`) is logged and skipped; a provider fetch failure/timeout is caught,
  logged with structured telemetry, and **emits a small user-visible failure state**
  (placeholder "embed failed to load" rather than nothing) so prose referencing the embed is
  not left dangling. `fetchOEmbed` gains an `AbortSignal` timeout (it has none today). One
  bad URL never blocks later URLs.
- **Security.** Keep `detectProvider` allowlist BEFORE any `fetchOEmbed` (no SSRF to
  arbitrary hosts — only allowlisted oEmbed endpoints are fetched). Parse every URL with
  `new URL()` and require `http:`/`https:`. DOMPurify still sanitizes the injected HTML; make
  `fetchAndRenderEmbed` **fail closed** (render nothing) if DOMPurify is absent, instead of
  the current unsanitized fallback. Provider regexes remain substring-ish — tightening them
  to origin/path checks is a NICE-TO-HAVE, not required for this change.
- **Async-in-sync.** `void embedFromMessage()` keeps `applyDispatchEventEffects` sync and
  non-blocking; fully guarded (per-URL try/catch + timeout) so a slow/failed oEmbed never
  stalls dispatch, rejects unhandled, or does unbounded post-dispatch work.
- **Inline-at-text-offset is a non-goal.** Embeds render as `caco.embed` event elements in
  the stream (today's behavior), not at the marker's character offset; a client-driven
  inline render is a separate, larger design.
- **Prompt nudge.** Add one line (where the `caco-actions` usage is documented in prompts.ts)
  describing the `caco-embed` block + supported providers, so the agent uses it.
- **No mid-session/registration concerns.** Pure parse + a guarded fire-and-forget effect +
  persisted records + a replay path + a render guard. Nothing registered; reversible (the
  tool is restorable from git).

## Acceptance

- **Parse oracle (pure):** `extractEmbedMarkers` — single URL; multiple URLs in one block;
  multiple blocks; mid-message block (not a trailer); unclosed fence → `[]`; blank/dup lines
  trimmed + within-message deduped; cap at `MAX_EMBEDS`; CRLF; a non-URL body line dropped;
  a supported+unsupported mix (both returned by the parser; provider filtering is later); a
  ```` ```caco-embed ```` sample **nested inside a longer outer fence is ignored**;
  occurrence indices are stable.
- **Streaming-suppression oracle (pure):** `stripStreamingEmbedBlocks` removes all top-level
  `caco-embed` blocks (closed and unclosed) while preserving surrounding prose — tested with
  multiple blocks, a completed block sitting in the unrendered tail, a later forming block
  that is NOT the last line, prose after a closed mid-message block, and a partial
  info-string (`` ```caco-emb ``).
- **Idempotency / replay (server):**
  - Delivering the same final `assistant.message` **twice** yields **one** stored embed
    output and **one** `caco.embed` per `(messageId, url, occurrence)` (stable key, reused
    `outputId`), not duplicates.
  - The same URL in two **different** messages embeds twice (no cross-session URL dedupe).
  - `streamHistory` reconstructs `caco.embed` for persisted marker embeds in deterministic
    order (`assistantMessageId`, then `occurrence`); a reconnecting/no-subscriber client gets
    every embed on replay.
  - Old `[output:xxx]` sessions still replay their embeds (back-compat path intact).
- **Server trigger:** a supported `caco-embed` URL → `storeEmbedOutput` + a `caco.embed`
  event; an unsupported URL → no embed, a logged skip, no throw; a fetch timeout/failure →
  caught, a failure placeholder, later URLs still processed; one bad URL never blocks others.
- **Render guard:** `markdown-renderer.ts` `code()` returns `''` for `caco-embed` (open and
  closed).
- **Removal:** `embed_media` absent from the tool surface and from `DEFAULT_DISABLED_TOOLS`;
  `CacoEmbedEvent`/`CacoEvent` types relocated and still imported cleanly; the `embed_media`
  client completion special case removed; the `[output:xxx]` replay path retained for old
  sessions and confirmed to have no remaining live producer.
- **Security:** `detectProvider` runs before any `fetchOEmbed`; non-`http(s)` URLs rejected
  by `new URL()`; `fetchAndRenderEmbed` fails closed without DOMPurify.
- **Visual signoff:** an embed produced via the marker renders identically to one produced by
  the old tool (same iframe, provider data-attr, sanitization), both live and after a reload.
  Show before/after.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **`src/embed-marker-parse.ts`** — `extractEmbedMarkers` (top-level-only, strict `new URL()`
   lines, occurrence indices, `MAX_EMBEDS`); parse oracle tests first.
2. **Streaming suppression** — `stripStreamingEmbedBlocks` (all top-level blocks, prose
   preserved) + shared fence primitive; suppression oracle tests.
3. **`markdown-renderer.ts`** — hide `caco-embed` in `code()`.
4. **Persistence + deps** — extend `DispatchEventDeps` with idempotent `storeEmbedOutput(key,…)`
   (keyed by `sessionId:messageId:url:occurrence`); wire `sessionCwd`/store from the
   `dispatchMessage` call sites; persist `type:'embed'` metadata carrying the key + message id.
5. **`dispatch-events.ts`** — guarded `void embedFromMessage` on final `assistant.message`
   (detectProvider → fetchOEmbed w/ timeout → storeEmbedOutput → `deps.onEvent`); idempotency
   + per-URL failure tests.
6. **History replay** — reconstruct `caco.embed` from persisted marker embeds in `streamHistory`
   (deterministic order); keep the old `[output:xxx]` path for legacy sessions; replay tests.
7. **Removal** — delete `embed_media`/`createDisplayTools` + `server.ts` wiring; relocate event
   types; remove the client completion special case; drop from `DEFAULT_DISABLED_TOOLS`; update
   `dev-docs-tool.ts`.
8. **Prompt nudge** — document `caco-embed` + providers in prompts.ts.
9. **Gates + visual signoff (live + reload).**

This mirrors A3 in shape, but is genuinely larger: A3 persisted a single meta field, whereas
embeds require a **persisted, deterministically-keyed, replayable record** plus a guarded
async effect and an anywhere/multiple marker. Inline-at-text positioning is a non-goal; full
visual parity (live + replay) with today's event-based embeds is the bar.
