# Same-origin guard — GPT-5.5 implementation review (branch `terminal-impl`)

One must-fix, folded. Carve-out placement, routing, ws guard, and absent-Origin self-call
handling all confirmed correct. Gates green after the fix (1391 tests).

| Severity | File | Issue | Resolution |
|---|---|---|---|
| Must-fix | `src/security/same-origin.ts` | Port normalization `replace(/:(80\|443)$/,'')` stripped both default ports from both sides → `http://localhost:443` false-accepted against Host `localhost`. | Made **scheme-aware**: strip only the *origin protocol's* default port from the Host header; `URL.host` already canonicalizes the origin side. Added 3 regression oracle cases (`http://h:443` vs `h` → deny, `https://h:80` vs `h` → deny, `http://h` vs `h:443` → deny). |

Confirmed clean by the review (no change needed):
- Carve-out regex `^/api/sessions/[^/]+/export$` is narrow; no over-match on trailing path.
- No state-changing Express route is mounted before the middleware; `/`, `/api/info`,
  `/api/favicon`, static are GET/safe and intentionally precede it.
- `/ws` uses the shared predicate and still admits the legitimate browser client.
- Absent-Origin ⇒ allow correctly passes the server's internal `fetch(${SERVER_URL}/...)`.

## Not yet validated
- Live browser smoke (app works end-to-end over the user's normal access path; terminal still
  attaches) — requires server restart + refresh + signoff before commit.
