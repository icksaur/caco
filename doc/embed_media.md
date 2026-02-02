# embed_media Tool

**Status**: Implemented (needs testing)  
**Last Updated**: 2026-02-01

---

## Current State

### What Works ✅

1. **Tool execution** - Agent calls `embed_media(url)`, server fetches oEmbed data
2. **Storage** - Embed HTML stored in `~/.caco/sessions/<id>/outputs/`
3. **Tool response** - Returns `[output:xxx]` marker with `toolTelemetry.outputId`
4. **oEmbed providers** - YouTube, Vimeo, SoundCloud, Spotify, Twitter/X
5. **Server emits `caco.embed`** - Synthetic event after tool completion
6. **Client renders embed** - Fetches output, injects iframe with DOMPurify
7. **History reload** - Works identically to live stream

---

## Data Flow

```
User: "embed this youtube video"
          │
          ▼
┌─────────────────────┐
│ embed_media tool    │
│ 1. fetchOEmbed(url) │
│ 2. storeOutput(html)│
│ 3. return outputId  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ SDK event: tool.execution_complete      │
│ {                                       │
│   toolName: 'embed_media',              │
│   result: { content: '[output:xxx]...' }│
│   // toolTelemetry extracted by parser  │
│ }                                       │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Server: session-messages.ts             │
│ Emits synthetic caco.embed event with   │
│ { outputId, provider, title }           │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Client: element-inserter.ts             │
│ caco.embed → embed-message (outer)      │
│           → embed-content (inner)       │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Client: event-inserter.ts               │
│ 'caco.embed' handler                    │
│ Fetches /api/outputs/:id                │
│ Injects iframe with DOMPurify           │
└─────────────────────────────────────────┘
```

---

## Implementation (Completed)

### Server: Emit caco.embed event

In `session-messages.ts`, after `tool.execution_complete` for `embed_media`:

```typescript
if (toolName === 'embed_media' && toolTelemetry?.outputId) {
  onEvent({ 
    type: 'caco.embed', 
    data: { 
      outputId: toolTelemetry.outputId,
      provider: toolTelemetry.provider,
      title: toolTelemetry.title
    } 
  });
}
```

### Client: Element mapping

In `element-inserter.ts`:

```typescript
// EVENT_TO_OUTER
'caco.embed': 'embed-message',

// EVENT_TO_INNER
'caco.embed': 'embed-content',
```

### Client: Content handler

In `event-inserter.ts`:

```typescript
'caco.embed': (element, data) => {
  const outputId = data.outputId as string | undefined;
  if (!outputId) {
    element.textContent = '❌ Missing embed outputId';
    return;
  }
  
  element.textContent = '⏳ Loading embed...';
  
  if (typeof window !== 'undefined') {
    fetchAndRenderEmbed(element, outputId);
  }
},
```

---

## History Reload

For embed to work on history reload:
1. Server emits `caco.embed` after each `tool.execution_complete` for `embed_media`
2. `caco.embed` event data contains `{ outputId, provider, title }`
3. Client handles `caco.embed` identically for live stream and history
4. Outputs stored on disk survive restarts (implemented in storage.ts)

History works automatically because the server re-emits `caco.embed` when replaying events.

---

## Testing

1. Run: `npm run dev`
2. Ask agent: "embed https://www.youtube.com/watch?v=dQw4w9WgXcQ"
3. Verify: YouTube embed appears in its own div below chat
4. Reload page, load same session
5. Verify: Embed reappears from history

---

## Files Modified

| File | Change |
|------|--------|
| `src/routes/session-messages.ts` | Emit `caco.embed` after embed_media tool |
| `public/ts/element-inserter.ts` | Add caco.embed → embed-message/embed-content mapping |
| `public/ts/event-inserter.ts` | Add caco.embed handler with fetchAndRenderEmbed |
| `public/style.css` | Add .embed-message and .embed-content styles |
| `doc/chatview-design.md` | Document caco.embed in event type tables |

---

## Notes

- DOMPurify normally strips iframes - need `ADD_TAGS: ['iframe']` for trusted embeds
- oEmbed HTML from YouTube/Vimeo is trusted (comes from official APIs)
- `caco.embed` is a Caco synthetic event type (not from SDK)
