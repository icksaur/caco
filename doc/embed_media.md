# embed_media Tool

**Status**: Partially functional  
**Last Updated**: 2026-02-01

---

## Current State

### What Works ✅

1. **Tool execution** - Agent calls `embed_media(url)`, server fetches oEmbed data
2. **Storage** - Embed HTML stored in `~/.caco/sessions/<id>/outputs/`
3. **Tool response** - Returns `[output:xxx]` marker with `toolTelemetry.outputId`
4. **oEmbed providers** - YouTube, Vimeo, SoundCloud, Spotify, Twitter/X

### What's Broken ❌

1. **Client doesn't fetch output** - No code calls `/api/outputs/:outputId`
2. **Client doesn't render embed** - No iframe injection, just shows text result
3. **History reload** - Output markers in history aren't rehydrated

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
│ Client: event-inserter.ts               │
│ 'tool.execution_complete' handler       │
│                                         │
│ Current: Renders as markdown code block │
│ Missing: Fetch output, inject embed     │
└─────────────────────────────────────────┘
```

---

## Fix Plan

### Option A: Handle in event-inserter.ts (recommended)

Modify `tool.execution_complete` handler to detect `embed_media` tool and render specially:

```typescript
'tool.execution_complete': async (element, data) => {
  const name = element.dataset.toolName || 'tool';
  
  // Special case: embed_media renders an iframe
  if (name === 'embed_media') {
    const outputId = extractOutputId(data);  // From toolTelemetry or result text
    if (outputId) {
      const res = await fetch(`/api/outputs/${outputId}?format=json`);
      const { data: html, metadata } = await res.json();
      
      // Create embed container
      const embed = document.createElement('div');
      embed.className = 'embed-container';
      embed.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['iframe'] });
      element.appendChild(embed);
      return;
    }
  }
  
  // Default handling...
}
```

### Option B: Synthetic event injection

Server enriches `tool.execution_complete` with embed data inline, avoiding fetch:

```typescript
// In session-messages.ts, after tool execution
if (event.type === 'tool.execution_complete') {
  const telemetry = extractToolTelemetry(event);
  if (telemetry?.outputId) {
    const output = getOutput(telemetry.outputId);
    if (output?.metadata.type === 'embed') {
      event.data._embed = {
        html: output.data,
        provider: output.metadata.provider
      };
    }
  }
}
```

### Option C: Post-render processing

After all events render, scan for `[output:xxx]` markers and replace:

```typescript
// In message-streaming.ts or a new module
function hydrateOutputMarkers(container: Element) {
  const regex = /\[output:([^\]]+)\]/g;
  // Find text nodes, fetch outputs, replace with embeds
}
```

---

## Recommended Approach

**Option A** is cleanest:
- Handles embed at render time (no post-processing)
- Works for live stream and history reload
- Keeps embed logic in one place

**Required changes:**
1. Extract `outputId` from `toolTelemetry` (already parsed by `sdk-event-parser.ts`)
2. Fetch `/api/outputs/:id?format=json` 
3. Inject sanitized HTML (allow iframes for embed providers)
4. Style embed container

---

## History Reload

For embed to work on history reload:
1. Output markers `[output:xxx]` are stored in SDK history
2. Client must parse these markers and fetch outputs
3. Outputs stored on disk survive restarts (implemented in storage.ts)

**Gap**: Client doesn't parse markers from history messages.

**Fix**: Same as Option A - handle in `tool.execution_complete` for history events.

---

## Testing

1. Run: `npm run dev`
2. Ask agent: "embed https://www.youtube.com/watch?v=dQw4w9WgXcQ"
3. Verify: YouTube embed appears inline in chat
4. Reload page, load same session
5. Verify: Embed reappears from history

---

## Files to Modify

| File | Change |
|------|--------|
| `public/ts/event-inserter.ts` | Add embed_media handling |
| `public/ts/types.ts` | Add OutputResponse type |
| `public/style.css` | Add .embed-container styles |

---

## Notes

- DOMPurify normally strips iframes - need `ADD_TAGS: ['iframe']` for trusted embeds
- oEmbed HTML from YouTube/Vimeo is trusted (comes from official APIs)
- Consider allowlisting only known provider domains for iframe src
