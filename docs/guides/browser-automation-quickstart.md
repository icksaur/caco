# Browser Automation Quickstart

Caco can drive a dedicated Microsoft Edge browser to interact with web UIs that have no API — read a record, click through a flow, fill a form. This is a **separate browser profile**, not your everyday Edge. You sign into it once; cookies persist across restarts.

See `docs/spec-browser-automation.md` for the full design.

## Prerequisites

- **Windows:** Microsoft Edge installed (default on Windows 10/11).
- **Linux (Arch/Dev Box):** `microsoft-edge-stable` from the AUR, or `chromium`/`google-chrome-stable` as a fallback.

## First run

Tell the agent in chat:

> "Open a browser and go to https://example.com"

The agent calls `caco_browser_ensure_running`, which spawns Edge detached via the helper script. No terminal stays open. The first time, the profile is empty — you'll see a fresh Edge window.

For corporate apps behind Entra SSO, follow the agent's prompt to sign in. Cookies and refresh tokens persist in `~/.caco/browser-profile` across Edge restarts.

## Visibility modes

| Mode | Use case |
|---|---|
| `visible` (default) | First-time sign-in. Demos. Selector debugging. |
| `hidden` | Daily driver on a workstation you actively use. Window stays minimized. |
| `headless` | Dev Box you only ever tunnel into. No window, lowest resource cost. |

The agent can pass `mode` to `caco_browser_ensure_running`. The mode is honored only on first launch; switching modes requires closing Edge first.

You can also run the helper yourself:

```powershell
# Windows
.\scripts\start-browser.ps1 -Mode hidden
```

```bash
# Linux
./scripts/start-browser.sh --mode headless
```

## Configuration

`~/.caco/browser-config.json` is written by the helper. Defaults are safe; the fields you may want to edit:

- `evalEnabled` (`false` by default) — flip to `true` to enable the `caco_browser_eval` escape hatch. **Note:** eval is a privileged primitive that can exfiltrate cookies; only enable for hosts you trust.
- `evalOriginAllowlist` — list of origins (e.g., `https://internal.corp.com`) where eval is permitted.
- `authOriginAllowlist` — hosts that, when navigated to, surface `auth_required` to the agent. Default includes Microsoft, Google, and Live IdPs.

`CACO_HOME` overrides the storage root (used by tests).

## Tools the agent uses

- `caco_browser_ensure_running` — start or attach to Edge.
- `caco_browser_navigate` — go to a URL.
- `caco_browser_snapshot` — read the page's accessibility tree.
- `caco_browser_action` — click, type, select, check, hover, press key, upload file.
- `caco_browser_screenshot` — capture PNG; agent links it via image-viewer.
- `caco_browser_eval` — JS escape hatch (disabled by default).

## Troubleshooting

- **"not_connected"** — Edge isn't running. Ask the agent to call `caco_browser_ensure_running`, or run the helper script yourself.
- **"launch_failed"** — Helper script failed. The `diagnostics` field in the error has the captured log output. Common causes: Edge not installed, port range exhausted, PowerShell ExecutionPolicy blocking the `.ps1`.
- **"auth_required"** — Your Entra session expired or the agent hit a login page. Sign in in the Edge window, then tell the agent to retry.
- **"browser_busy"** — Another session is mid-flow. Wait or use a single session.
- **Profile got weird** — Delete `~/.caco/browser-profile` and re-run the helper. You'll need to re-sign-in to your apps.

## What's NOT in v1

- Multi-tab orchestration. New tabs opened by clicks are ignored.
- File downloads (agent clicks "Export CSV", file saves locally, agent can't read it).
- Closed shadow DOM.
- Visible-text matching for `<select>` (only `value` attribute).
- macOS Edge path resolution.
