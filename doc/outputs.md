# Outputs: Display-Only Tools

Display outputs let users **see** large content (files, terminal output, images) without consuming LLM context.

## The Pattern

```
"Show me package.json"  →  User wants to SEE it (no analysis needed)
"Fix my package.json"   →  Agent needs to READ it (uses normal tools)
```

When the user just wants to view something, our display tools:
1. Read the content
2. Store it in an **in-memory cache** (30-min TTL)
3. Return only a **confirmation** to the LLM
4. UI fetches and renders directly from cache

**Result:** ~20 tokens instead of ~500+ tokens per file view.

---

## Architecture

```
┌─────────────────┐                      ┌───────────────────┐
│  Display Tool   │   storeOutput(data)  │  In-Memory Cache  │
│  (SDK handler)  │  ───────────────────►│  Map + 30min TTL  │
└─────────────────┘    returns outputId  └───────────────────┘
        │                                         │
        │ toolTelemetry: { outputId }             │ GET /api/outputs/:id
        ▼                                         ▼
┌─────────────────┐                      ┌───────────────────┐
│  LLM Context    │                      │  Browser UI       │
│  (tiny summary) │                      │  (full content)   │
└─────────────────┘                      └───────────────────┘
```

---

## Display Tools

| Tool | Use Case | LLM Sees |
|------|----------|----------|
| `embed_media` | "Show me this YouTube video" | "Embedding queued for YouTube: ..." |

### Implementation: [src/display-tools.ts](src/display-tools.ts)

```javascript
const embedMedia = defineTool("embed_media", {
  description: `Embed media (YouTube, Vimeo, SoundCloud, Spotify) inline in chat.`,
  
  parameters: z.object({
    url: z.string().describe('URL of the media to embed')
  }),

  handler: async ({ url }) => {
    const embedData = await fetchOEmbed(url);
    const outputId = storeOutput(embedData.html, { type: 'embed', ... });
    
    // LLM only sees this
    return {
      textResultForLlm: `[output:${outputId}] Embedding queued for ${provider}: ...`,
      toolTelemetry: { outputId }
    };
  }
});
```

Note: Rendering happens client-side. Success cannot be confirmed at tool layer.

---

## Server Components

### Output Cache ([src/storage.ts](src/storage.ts))

```javascript
const outputCache = new Map();
const OUTPUT_TTL = 30 * 60 * 1000;  // 30 minutes

function storeOutput(data, metadata = {}) {
  const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  outputCache.set(id, { data, metadata, cachedAt: Date.now() });
  setTimeout(() => outputCache.delete(id), OUTPUT_TTL);
  return id;
}
```

### Output API ([src/routes/api.ts](src/routes/api.ts))

```javascript
app.get('/api/outputs/:id', (req, res) => {
  const output = getOutput(req.params.id);
  if (!output) return res.status(404).json({ error: 'Expired' });
  
  if (metadata.mimeType) res.setHeader('Content-Type', metadata.mimeType);
  res.send(output.data);
});
```

---

## Client Rendering

The `tool.execution_complete` event contains `outputId` in `toolTelemetry`. The client fetches content from `/api/outputs/:id` and renders appropriately based on metadata type.

---

## Configuration

```javascript
// server.ts - session creation
const session = await sessionManager.create(cwd, {
  tools: displayTools,
  // ...
});
```

---

## Why In-Memory?

| Approach | Pros | Cons |
|----------|------|------|
| **In-memory (current)** | Fast, auto-cleanup, no disk clutter | Lost on restart |
| Disk persistence | Survives restarts, shareable | Cleanup needed |
| Database | Scalable, queryable | Overkill for dev tool |

For a development-focused web UI, ephemeral in-memory storage is ideal.
