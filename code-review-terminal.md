# Terminal feature — GPT-5.5 code review (branch `terminal-impl`)

All four findings were warranted and have been folded in. Gates green after fixes
(typecheck ×2, lint:strict, knip, build:client, 1369 tests).

| Severity | File | Issue | Resolution |
|---|---|---|---|
| Must-fix | `src/routes/websocket.ts` | Same-origin guard accepts any matching Origin/Host pair → DNS-rebinding can reach the shell channel. | Added `isAllowedHost` + `isAllowedWsUpgrade`: upgrade now requires same-origin **and** a Host in a local allowlist (`localhost`, `127.0.0.1`, `[::1]`, `SERVER_URL` host, `os.hostname()`). New regression tests incl. the rebinding case. |
| Must-fix | `src/terminal-manager.ts` | `SIGTERM`/`SIGINT` listeners suppressed Node's default shutdown. | Removed signal ownership; keep only a non-suppressing `process.once('exit', …)`. The server's existing SIGINT handler calls `process.exit`, which fires `exit` and reaps the ptys. |
| Should-fix | `src/terminal-manager.ts` | Ring replay could duplicate bytes still queued for the 16 ms live flush on re-attach. | Ring is now written **on flush**, not on raw pty data, so an attach snapshot never overlaps with un-broadcast output. Client also resets the xterm before every (re-)attach → exact reconstruction. |
| Should-fix | `src/terminal-manager.ts` | Re-attach to an existing pty ignored the client's fitted cols/rows. | Re-attach now resizes the existing pty to the supplied (clamped) dims. |

No issue found with SDK-history persistence or applet `onSessionEvent` leakage (terminal
output never persists to `events.jsonl` and is excluded from applet event delivery).

## Not yet validated
- Live browser run (xterm rendering, glyph/panel layout, real shell I/O) — requires server
  restart + hard refresh + visual signoff before commit.
