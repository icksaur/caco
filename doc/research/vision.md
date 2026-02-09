# Vision & Automation Exploration

Investigating capabilities for applet testing, vision features, and self-prompting.

## Questions to Explore

1. Can JavaScript capture rendered DOM as an image and submit to chat?
2. Can applets access the camera and feed images to the agent?
3. Can the agent read image files from disk?
4. Can JavaScript trigger a new message/prompt programmatically?
5. Can MCP tools return image data directly to the agent?
6. Can canvas pixel data be extracted and analyzed?

---

## 1. DOM Screenshot Capture

**Question:** Can JS take an image of rendered DOM content?

**Answer: Yes, with libraries or native APIs**

### Option A: html2canvas (library)
```javascript
// Renders DOM to canvas, then extracts image
import html2canvas from 'html2canvas';

const canvas = await html2canvas(document.getElementById('applet-content'));
const dataUrl = canvas.toDataURL('image/png');
// dataUrl is "data:image/png;base64,..." - ready for upload
```

### Option B: Native browser APIs (limited)
- `Element.getClientRects()` gives geometry but not pixels
- No native "screenshot element" API in browsers (security)
- Would need html2canvas or similar

### Option C: Server-side with Puppeteer
```javascript
// Server could render applet HTML and screenshot
const puppeteer = require('puppeteer');
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setContent(appletHtml);
const screenshot = await page.screenshot({ encoding: 'base64' });
```

**Recommendation:** Bundle html2canvas (~40KB) for client-side capture. Add a global `captureApplet()` function that returns base64 PNG.

---

## 2. Submitting Images to Chat Programmatically

**Question:** Can applet JS put a captured image into chat input?

**Current state:** The chat form accepts pasted images. The mechanism is:
1. User pastes → `paste` event handler extracts image
2. Image stored in `pendingImageData` variable
3. On submit, sent as `imageData` in POST body

**Can we trigger this from JS? Yes:**

```javascript
// From applet JS, we could expose a function:
async function submitImageToChat(base64DataUrl, prompt = '') {
  // Option 1: Programmatically set the pending image and trigger submit
  window.pendingImageData = base64DataUrl;
  document.getElementById('chatInput').value = prompt;
  document.getElementById('chatForm').requestSubmit();
  
  // Option 2: Direct API call
  await fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt,
      imageData: base64DataUrl
    })
  });
}
```

**Implementation needed:**
- Expose `submitToChat(prompt, imageData?)` as a global function in applet runtime
- Connect to SSE stream to receive response
- Handle the streaming UI update

---

## 3. Camera Access in Applets

**Question:** Can applets use the camera and feed images to the agent?

**Answer: Yes, standard Web APIs work**

```javascript
// Request camera access
const stream = await navigator.mediaDevices.getUserMedia({ video: true });

// Create video element
const video = document.createElement('video');
video.srcObject = stream;
await video.play();

// Capture frame to canvas
const canvas = document.createElement('canvas');
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;
canvas.getContext('2d').drawImage(video, 0, 0);

// Get as data URL
const imageData = canvas.toDataURL('image/jpeg', 0.8);

// Submit to agent
await submitToChat('Analyze this camera image', imageData);

// Stop camera
stream.getTracks().forEach(t => t.stop());
```

**Use cases:**
- OCR: "Read this document I'm holding"
- Object recognition: "What is this?"
- Barcode/QR scanning
- Visual verification of physical items

**Implementation needed:**
- Camera permission handling (user must grant)
- Global `captureCamera()` function
- Integration with chat submission

---

## 4. Agent Reading Image Files

**Question:** Can the agent read image files from disk?

**Current state:**
- Use SDK's `view` tool with image paths
- Agent receives image content for analysis

**Solution: MCP tools CAN return images**

The Copilot SDK supports image content in tool results:

```typescript
// In tool handler
return {
  content: [
    {
      type: 'image',
      data: base64ImageData,  // base64-encoded image
      mimeType: 'image/png'
    }
  ]
};
```

**New tool: `read_image`**
```typescript
const readImage = defineTool('read_image', {
  description: 'Read an image file and return it to the agent for analysis.',
  parameters: z.object({
    path: z.string().describe('Absolute path to image file')
  }),
  handler: async ({ path }) => {
    const data = await readFile(path);
    const ext = path.split('.').pop()?.toLowerCase();
    const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png';
    
    return {
      content: [
        { type: 'image', data: data.toString('base64'), mimeType }
      ]
    };
  }
});
```

**This enables:**
- Agent analyzing screenshots saved to disk
- Camera captures saved to temp files then analyzed
- Automated visual testing of applets

---

## 5. Self-Prompting: JS Triggering Agent Messages

**Question:** Can JavaScript write to the session and prompt itself?

**Answer: Yes, via API call**

```javascript
// From applet JS
async function promptAgent(message, imageData = null) {
  const response = await fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: message,
      imageData: imageData
    })
  });
  
  const { streamId } = await response.json();
  
  // Connect to SSE stream for response
  const eventSource = new EventSource(`/api/stream/${streamId}`);
  
  return new Promise((resolve, reject) => {
    let fullResponse = '';
    eventSource.addEventListener('assistant.message', (e) => {
      const data = JSON.parse(e.data);
      fullResponse = data.content;
    });
    eventSource.addEventListener('done', () => {
      eventSource.close();
      resolve(fullResponse);
    });
    eventSource.addEventListener('error', reject);
  });
}
```

**Use cases:**
- Applet requests agent to analyze its current state
- Automated workflows: "Now do step 2"
- Visual testing: capture screenshot → ask agent to verify

**Concerns:**
- Infinite loops (applet prompts agent, agent updates applet, applet prompts again)
- Need rate limiting or explicit user approval for auto-prompts
- Security: malicious applets could drain API quota

**Safeguards:**
- Require user click to initiate agent prompt
- Or: limit auto-prompts per session (e.g., 5)
- Or: visual indicator "Applet is requesting agent attention"

---

## 6. Canvas Data Extraction

**Question:** Can canvas pixel data be queried?

**Answer: Yes, standard API**

```javascript
const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d');

// Get all pixel data
const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
// imageData.data is Uint8ClampedArray of RGBA values

// Get specific pixel
const x = 100, y = 50;
const i = (y * canvas.width + x) * 4;
const r = imageData.data[i];
const g = imageData.data[i + 1];
const b = imageData.data[i + 2];
const a = imageData.data[i + 3];

// Export as image
const dataUrl = canvas.toDataURL('image/png');
```

**For applet testing:**
```javascript
// Applet could expose test hooks
function verifyRendering() {
  const canvas = document.querySelector('canvas');
  const dataUrl = canvas.toDataURL();
  
  // Option 1: Hash comparison
  const hash = await crypto.subtle.digest('SHA-256', await fetch(dataUrl).then(r => r.arrayBuffer()));
  return expectedHash === bufferToHex(hash);
  
  // Option 2: Send to agent for visual verification
  await promptAgent('Verify this chart looks correct', dataUrl);
}
```

---

## 7. Automated Applet Testing Architecture

Combining the above capabilities:

```
┌─────────────────────────────────────────────────────────────┐
│                     Test Orchestration                       │
│                                                              │
│  1. Agent creates/modifies applet                           │
│  2. Agent calls test_applet tool                            │
│  3. Server renders applet (Puppeteer or client-side)        │
│  4. Screenshot captured → returned to agent                 │
│  5. Agent analyzes screenshot                               │
│  6. Agent reports pass/fail                                 │
└─────────────────────────────────────────────────────────────┘
```

### Option A: Client-Side Testing (html2canvas)
```typescript
// New tool: capture_applet_screenshot
const captureApplet = defineTool('capture_applet_screenshot', {
  description: 'Capture screenshot of current applet for visual verification.',
  parameters: z.object({}),
  handler: async () => {
    // Signal client to capture
    triggerCapture(); // Sets flag in applet-state
    
    // Wait for client to POST screenshot
    const screenshot = await waitForCapture(5000);
    
    return {
      content: [
        { type: 'image', data: screenshot, mimeType: 'image/png' }
      ]
    };
  }
});
```

### Option B: Server-Side Testing (Puppeteer)
```typescript
// Render applet in headless browser
const captureApplet = defineTool('capture_applet_screenshot', {
  description: 'Render and capture applet screenshot for testing.',
  parameters: z.object({
    slug: z.string().optional().describe('Applet slug, or current if omitted')
  }),
  handler: async ({ slug }) => {
    const applet = slug ? await loadStoredApplet(programCwd, slug) : getApplet();
    
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Inject applet HTML/CSS/JS
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head><style>${applet.css || ''}</style></head>
      <body>${applet.html}</body>
      <script>${applet.js || ''}</script>
      </html>
    `);
    
    await page.waitForTimeout(500); // Let JS run
    const screenshot = await page.screenshot({ encoding: 'base64' });
    await browser.close();
    
    return {
      content: [
        { type: 'image', data: screenshot, mimeType: 'image/png' }
      ]
    };
  }
});
```

---

## 8. Implementation Roadmap

### Phase 1: Foundation
- [ ] Add `read_image` MCP tool (return image to agent)
- [ ] Add `submitToChat(prompt, imageData?)` global in applet runtime
- [ ] Verify image submission works end-to-end

### Phase 2: Capture
- [ ] Bundle html2canvas
- [ ] Add `captureApplet()` global function
- [ ] Add `captureCamera()` global function

### Phase 3: Self-Prompting
- [ ] Add `promptAgent(message, imageData?)` global
- [ ] Add safeguards (rate limiting, user approval)
- [ ] Handle SSE response in applet context

### Phase 4: Automated Testing
- [ ] Add `capture_applet_screenshot` MCP tool
- [ ] Choose: client-side (html2canvas) vs server-side (Puppeteer)
- [ ] Create test harness applet

### Phase 5: Vision Workflows
- [ ] Camera-based OCR applet
- [ ] Visual diff testing
- [ ] Screenshot comparison tool

---

## 9. Security Considerations

| Risk | Mitigation |
|------|------------|
| Infinite prompt loops | Rate limit auto-prompts, require user action |
| API quota drain | Cap auto-prompts per session |
| Camera privacy | Standard browser permission model |
| Malicious applets | Applets already sandboxed, but review auto-prompt |
| Large image uploads | Size limits on imageData |

---

## 10. Quick Wins

**Easiest to implement first:**

1. **`read_image` tool** - Just read file and return as image content. ~20 lines.
2. **`submitToChat` global** - Wire up to existing form submission. ~30 lines.
3. **`captureCamera` global** - Standard getUserMedia API. ~40 lines.

These three enable the core workflow:
- Camera applet captures image
- Applet submits to chat with prompt
- Agent receives and analyzes image

---

## Notes

- The Copilot SDK definitely supports image content in tool results
- Browser camera API requires HTTPS in production (localhost is exempt)
- html2canvas has some CSS limitations but works for most cases
- Puppeteer adds ~300MB to node_modules but is most reliable for testing