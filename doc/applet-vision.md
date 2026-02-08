# Applet Vision

Spec for applet-generated images (canvas, screenshots) and agent visual analysis.

## Use Cases

### Phase 1: Applet → Agent Image Submission

**Doodle applet:**
1. User draws on canvas
2. Clicks "Send to Agent" button
3. Canvas image submitted with prompt
4. Agent analyzes the image and responds

### Phase 2: Agent → Applet → Agent Round-Trip (Future)

**SVG renderer:**
1. Agent calls `applet_invoke` with SVG XML
2. Applet renders SVG to canvas, captures image
3. Applet returns rendered image to agent
4. Agent analyzes result, iterates on SVG

*Requires `applet_invoke` tool - see Phase 2 section.*

## Current State

### What Works
- `saveTempFile(dataUrl)` - Saves image to `~/.caco/tmp/`, returns `{ path }`
- Backend `/api/sessions/:id/messages` accepts `imageData` field
- SDK `view` tool can read image files from disk

### Current Documented Pattern
```javascript
// From applet-tools.ts documentation
const { path } = await saveTempFile(canvas.toDataURL('image/png'));
await sendAgentMessage(`Analyze image at ${path}`);  // Agent uses view tool
```

**Problems:**
1. Indirect - requires agent to call `view` tool
2. Agent may not understand to view the file
3. Extra disk I/O

### Gap
`sendAgentMessage(prompt)` doesn't support `imageData` parameter, but the backend does.

## Phase 1: Add imageData to sendAgentMessage

### API Change

```typescript
// Current
async function sendAgentMessage(prompt: string, appletSlug?: string): Promise<void>

// Proposed (options-only, no backward compat needed)
async function sendAgentMessage(
  prompt: string, 
  options?: { 
    appletSlug?: string;
    imageData?: string;  // data:image/...;base64,...
  }
): Promise<void>
```

*Breaking change OK: Only 1 applet uses this, with prompt-only.*

### Size Limit

The server uses Express's default body limit of **100KB** for JSON. Base64 encoding has ~33% overhead, so raw images must be under ~75KB.

Reference: [security.md#8-no-request-size-limits](security.md#8-no-request-size-limits) documents this limit and a recommendation to increase to 10MB.

```typescript
const MAX_IMAGE_SIZE = 100 * 1024;  // 100KB server limit
if (options.imageData && options.imageData.length > MAX_IMAGE_SIZE) {
  throw new Error('Image too large (max 100KB)');
}
```

### Usage
```javascript
// Doodle applet
const canvas = document.getElementById('canvas');
const imageData = canvas.toDataURL('image/png');

await sendAgentMessage('What is this drawing?', { imageData });
```

### Implementation

**File:** `public/ts/applet-runtime.ts`

```typescript
const MAX_IMAGE_SIZE = 100 * 1024;  // Server's default Express JSON limit

async function sendAgentMessage(
  prompt: string, 
  options?: { appletSlug?: string; imageData?: string }
): Promise<void> {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    throw new Error('No active session - cannot send agent message');
  }
  
  // Validate image size (100KB JSON body limit)
  if (options?.imageData && options.imageData.length > MAX_IMAGE_SIZE) {
    throw new Error('Image too large (max 100KB)');
  }
  
  const slug = options?.appletSlug ?? currentApplet?.slug;
  
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      source: 'applet',
      appletSlug: slug,
      imageData: options?.imageData
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}
```

**Lines changed:** ~15 lines

### Deprecate saveTempFile for Images

Once `imageData` works, update docs to prefer direct submission:

```javascript
// ❌ Old pattern (still works, but indirect)
const { path } = await saveTempFile(canvas.toDataURL('image/png'));
await sendAgentMessage(`View the image at ${path}`);

// ✅ New pattern (direct)
await sendAgentMessage('Analyze this', { imageData: canvas.toDataURL() });
```

Keep `saveTempFile` for non-image use cases (agent-generated files, etc.).

## Phase 2: Agent→Applet→Agent Round-Trip (Future)

> "agent sets applet state, expects applet to render something based on that state, and calls get-applet-state. Can applets reliably react?"

### Scenario
1. Agent calls `set_applet_state({ data: [...] })`
2. Applet receives via `onStateUpdate`, renders chart
3. Agent calls `get_applet_state` expecting `{ chartRendered: true, imageData: '...' }`

### Timing Problem
- WebSocket delivery is async
- Applet render time varies
- Agent's `get_applet_state` may fire before applet updates

### Current Behavior
- `set_applet_state` returns immediately (fire-and-forget)
- No acknowledgment that applet received/processed
- `get_applet_state` reads whatever state applet has pushed

### Solution: `applet_invoke` Tool

```typescript
// New tool that sends request and waits for response
const result = await applet_invoke({ 
  action: 'renderSVG', 
  svg: '<svg>...</svg>' 
});
// result: { imageData: 'data:image/png;base64,...' }
```

**Implementation:**
1. Agent calls `applet_invoke` with request
2. Server sends to applet via WebSocket with correlationId
3. Applet processes, calls `respondToInvoke(correlationId, result)`
4. Server returns result to agent (or times out)

**Effort:** ~100+ lines, shares infra with applet-agent-comm correlation tracking.

**Deferred until:** Concrete use case requires it.

## Files to Modify

| File | Change | Phase |
|------|--------|-------|
| `public/ts/applet-runtime.ts` | Add `imageData` option, 100KB size limit | 1 |
| `doc/API.md` | Document new signature, deprecate temp-file pattern | 1 |

## Phase 1 Implementation Steps

### Step 1: Modify sendAgentMessage signature

**File:** `public/ts/applet-runtime.ts`

1. Locate `sendAgentMessage` function (around line 218)
2. Change signature from `(prompt: string, appletSlug?: string)` to `(prompt: string, options?: MessageOptions)`
3. Add `MessageOptions` interface above the function:
   ```typescript
   interface MessageOptions {
     appletSlug?: string;
     imageData?: string;
   }
   ```

### Step 2: Add size validation

Add constant and validation before the fetch call:

```typescript
const MAX_IMAGE_SIZE = 100 * 1024;  // Express default JSON limit

if (options?.imageData && options.imageData.length > MAX_IMAGE_SIZE) {
  throw new Error('Image too large (max 100KB)');
}
```

### Step 3: Update request body

Modify the `body: JSON.stringify(...)` to include `imageData`:

```typescript
body: JSON.stringify({
  prompt,
  source: 'applet',
  appletSlug: options?.appletSlug ?? currentApplet?.slug,
  imageData: options?.imageData
})
```

### Step 4: Update API.md documentation

**File:** `doc/API.md`

1. Find `sendAgentMessage` in the Applet API section
2. Update signature documentation
3. Add `imageData` option description
4. Add deprecation note for temp-file image pattern:
   ```markdown
   > **Deprecated for images:** Use `imageData` option instead of 
   > `saveTempFile` + file path. The temp-file pattern still works 
   > but requires agent to call `view` tool.
   ```

### Step 5: Test

1. Create test applet with canvas
2. Draw something, call `sendAgentMessage('What is this?', { imageData })`
3. Verify agent receives and analyzes the image
4. Test size limit error with large image

## Effort

| Phase | Scope | Lines |
|-------|-------|-------|
| 1 | `sendAgentMessage` with `imageData` | ~15 |
| 2 | `applet_invoke` round-trip tool | ~100+ |

## Decision

✅ **Phase 1**: Implement `imageData` option (100KB limit per current server config)
⏸️ **Phase 2**: Defer `applet_invoke` until SVG renderer or similar use case materializes

## Notes

The 100KB limit is the current Express default. If larger images are needed, see [security.md#8-no-request-size-limits](security.md#8-no-request-size-limits) for a recommendation to configure `express.json({ limit: '10mb' })` server-wide.
