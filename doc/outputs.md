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
| `render_file_contents` | "Show me config.js" | "Displayed config.js (50 lines)" |
| `run_and_display` | "Run the tests" | "Command completed (exit 0, 200 lines)" |
| `display_image` | "Show me logo.png" | "Displayed image logo.png" |

### Implementation: [src/display-tools.js](src/display-tools.js)

```javascript
const renderFileContents = defineTool("render_file_contents", {
  description: `Display a file directly to the user. Use for "show me", "cat", "view".
                You receive confirmation only, not the file contents.`,
  
  parameters: z.object({
    path: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional()
  }),

  handler: async ({ path, startLine, endLine }) => {
    const content = await readFile(path, 'utf-8');
    
    // Store full content in cache
    const outputId = storeOutput(content, { type: 'file', path });
    
    // LLM only sees this
    return {
      textResultForLlm: `Displayed ${path} to user (${lines.length} lines)`,
      toolTelemetry: { outputId }  // UI uses this to fetch content
    };
  }
});
```

---

## Server Components

### Output Cache ([server.js](server.js#L59-L77))

```javascript
const displayOutputs = new Map();
const OUTPUT_TTL = 30 * 60 * 1000;  // 30 minutes

function storeOutput(data, metadata = {}) {
  const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  displayOutputs.set(id, { data, metadata, createdAt: Date.now() });
  setTimeout(() => displayOutputs.delete(id), OUTPUT_TTL);
  return id;
}
```

### Output API ([server.js](server.js#L237-L264))

```javascript
app.get('/api/outputs/:id', (req, res) => {
  const output = getOutput(req.params.id);
  if (!output) return res.status(404).json({ error: 'Expired' });
  
  if (metadata.mimeType) res.setHeader('Content-Type', metadata.mimeType);
  res.send(output.data);
});
```

### SSE Event Processing ([server.js](server.js#L475-L495))

The `tool.execution_complete` event contains `outputId` in `toolTelemetry`. The server extracts it and forwards to the client.

---

## Client Rendering ([public/chat.js](public/chat.js#L639-L720))

```javascript
async function renderDisplayOutput(output) {
  const res = await fetch(`/api/outputs/${output.id}?format=json`);
  const { data, metadata } = await res.json();
  
  if (metadata.type === 'file') {
    // Syntax-highlighted code block
    const markdown = `\`\`\`${metadata.highlight}\n${data}\n\`\`\``;
    container.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
    hljs.highlightAll();
    
  } else if (metadata.type === 'image') {
    // Direct image element
    const img = document.createElement('img');
    img.src = `/api/outputs/${output.id}`;
    container.appendChild(img);
  }
}
```

---

## Configuration

Built-in `view` tool is disabled so the agent prefers our display tools:

```javascript
// server.js - session creation
activeSessionId = await sessionManager.create(cwd, {
  tools: displayTools,
  excludedTools: ['view']  // Use our display_image instead
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
