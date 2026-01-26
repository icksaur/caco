# Security TODO

**Scope:** Localhost single-user development environment  
**Primary Concern:** XSS and malicious payloads from LLM responses

---

## ✅ Already Implemented

- [x] DOMPurify sanitization on markdown output
- [x] HTML escaping for user input
- [x] Localhost-only binding (`127.0.0.1`)
- [x] Temp file cleanup after use
- [x] Content Security Policy headers
- [x] Comprehensive HTMX/event handler blocklist

---

## ✅ Completed

### 1. Add Content Security Policy

Defense-in-depth against XSS if sanitization ever fails.

**Status:** ✅ Implemented in server.js

### 2. Verify DOMPurify Configuration

Ensure current config covers all attack vectors.

**Status:** ✅ Expanded to include:
- All HTMX attributes (24 total)
- All JavaScript event handlers (40+ handlers)
- Additional form elements: `textarea`, `select`, `option`

---

## 📝 Deferred (Low Risk for Scope)

### CSRF Protection

**Risk:** Malicious websites could POST to localhost:3000 while you browse.

**Mitigation factors:**
- Same-Origin Policy blocks attackers from reading responses
- Attacker can trigger actions but can't exfiltrate data
- Requires you to visit malicious site while server runs
- AI agent already runs with your permissions

**Verdict:** Low priority. Revisit if threat model changes.

### Other Items Not Implemented

- Path restrictions: AI agent needs filesystem access to be useful
- Rate limiting: Single user, no abuse concern
- Session encryption: Local files, same user
- Audit logging: Overkill for personal dev tool

---

## 🔒 Maintenance

Periodic:
- [ ] Run `npm audit`
- [ ] Check for DOMPurify updates
- [ ] Verify server binds to `127.0.0.1`
