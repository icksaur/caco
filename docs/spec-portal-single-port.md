# Portal over one port

## Goals

The portal (`/portal.html` on the laptop, port 53000) shows every Caco instance
in iframes. Today each iframe loads the peer's own origin (`http://localhost:53001`,
`:53002`), which exists only on the laptop, where `devtunnel` forwards those
ports. From a phone or another machine that reaches the laptop through one
tunnel, those iframes cannot load.

Goal: the laptop's Caco serves each peer under its own origin at
`/peer/<key>/`, so the whole portal (every instance, the merged pager, and the
peer tools) works through the single tunnel to port 53000.

- Phase A (prerequisite) makes the client work under a path prefix. With no
  prefix it must behave exactly as today. It ships and is tested on its own.
- Phase B adds the reverse proxy on the hub.
- Phase C switches the portal and merged pager to proxied URLs.

Non-goals: multiplexing Caco's own features across instances (the overview and
peer tools already do that server side); proxying anything that is not a
registered peer; authentication between instances; chaining (a proxied
instance proxying further); MCP OAuth flows inside a proxied instance.

## Design

### Terms

- **Hub**: the Caco the browser talks to (the laptop, 53000).
- **Peer**: an entry from `getPeers()` whose origin passes the overview's rule
  (loopback, or `CACO_PEERS_ALLOW_REMOTE`).
- **Route key**: base64url of the peer's normalized origin including the scheme
  (`http://localhost:53001` gives `aHR0cDovL2xvY2FsaG9zdDo1MzAwMQ`). It is
  derived from the origin, so it is stable without a learned instance id, never
  collides across schemes, and contains no characters Express decodes.
- **Proxyable peer**: `isProxyablePeer(peer)` in `src/peer-proxy.ts`: a peer from
  `getPeers()` with a valid origin that passes the overview origin rule. The
  same predicate decides proxy routing, portal iframe URLs, favicons and pager
  targets (served to the portal by `GET /api/peers` as a `proxyPath` field).
- **Base path**: the prefix a page was served under: `/` normally,
  `/peer/<key>/` through the hub.

### Phase A: base-path-aware client

**Server.** For each page it serves (`/`, `/pager.html`), the server determines
the base path:
- `X-Caco-Base-Path` request header if it matches
  `^/peer/[A-Za-z0-9_-]{1,200}/# Portal over one port

## Goals

The portal (`/portal.html` on the laptop, port 53000) shows every Caco instance
in iframes. Today each iframe loads the peer's own origin (`http://localhost:53001`,
`:53002`), which exists only on the laptop, where `devtunnel` forwards those
ports. From a phone or another machine that reaches the laptop through one
tunnel, those iframes cannot load.

Goal: the laptop's Caco serves each peer under its own origin at
`/peer/<key>/`, so the whole portal (every instance, the merged pager, and the
peer tools) works through the single tunnel to port 53000.

- Phase A (prerequisite) makes the client work under a path prefix. With no
  prefix it must behave exactly as today. It ships and is tested on its own.
- Phase B adds the reverse proxy on the hub.
- Phase C switches the portal and merged pager to proxied URLs.

Non-goals: multiplexing Caco's own features across instances (the overview and
peer tools already do that server side); proxying anything that is not a
registered peer; authentication between instances; chaining (a proxied
instance proxying further); MCP OAuth flows inside a proxied instance.

## Design

### Terms

- **Hub**: the Caco the browser talks to (the laptop, 53000).
- **Peer**: an entry from `getPeers()` whose origin passes the overview's rule
  (loopback, or `CACO_PEERS_ALLOW_REMOTE`).
- **Route key**: base64url of the peer's normalized origin including the scheme
  (`http://localhost:53001` gives `aHR0cDovL2xvY2FsaG9zdDo1MzAwMQ`). It is
  derived from the origin, so it is stable without a learned instance id, never
  collides across schemes, and contains no characters Express decodes.
- **Proxyable peer**: `isProxyablePeer(peer)` in `src/peer-proxy.ts`: a peer from
  `getPeers()` with a valid origin that passes the overview origin rule. The
  same predicate decides proxy routing, portal iframe URLs, favicons and pager
  targets (served to the portal by `GET /api/peers` as a `proxyPath` field).
- **Base path**: the prefix a page was served under: `/` normally,
  `/peer/<key>/` through the hub.

### Phase A: base-path-aware client

**Server.** For each page it serves (`/`, `/pager.html`), the server determines
the base path:
- `X-Caco-Base-Path` request header if it matches
;
- otherwise `/`.

It injects `window.CACO_BASE = "<base>"` next to the existing
`SERVER_HOSTNAME` injection, and a `<base href="<base>">` tag as the first
element of `<head>`. `index.html` and `pager.html` use relative asset URLs
(`caco.png`, `bundle.js`, `style.css`), so the `<base>` tag resolves them under
the prefix. The header is display-only: a spoofed value can only break the
spoofer's own page, and it never affects routing or authorization on the peer.

`/` and `/pager.html` must not be cached across base paths: send
`Cache-Control: no-store` on the injected HTML (index already is generated per
start; it becomes per request).

**Client.** New module `public/ts/base-path.ts`:
- `BASE`: `window.CACO_BASE` or `/`;
- `withBase(path)`: for a string starting with exactly one `/`, returns
  `BASE + path.slice(1)`; any other string (relative, `//host`, `http:`,
  `data:`, `blob:`) is returned unchanged;
- `installFetchBase()`: wraps `window.fetch` once so a string or `URL` or
  `Request` whose URL is same-origin and absolute-path gets `withBase`. It is
  idempotent: a path already under `BASE` is left alone, so a URL built from
  `location.href` is never prefixed twice. A rewritten `Request` keeps its
  method, headers, body, credentials, signal and duplex. When `BASE` is `/`,
  the wrapper is not installed at all.
- The server injects a tiny inline script with `CACO_BASE` and the wrapper
  before any other script, so it covers `main.ts` and the pager's inline
  script alike (the pager has no bundled entry).

The fetch wrapper covers core code, applets (user JS runs in the page and calls
`fetch('/api/...')`), and extensions. Everything that is not `fetch` uses
`withBase` explicitly. From the current code:

| Kind | Sites |
|---|---|
| WebSocket URL | `websocket.ts` (`/ws`) |
| Dynamic `import()` | `extension-loader.ts` (client.js) |
| `<link href>` | `main.ts` (themes, extension CSS) |
| `<img src>`, `<iframe src>` | `session-panel.ts` and `context-footer.ts` (session icon), `command-registry.ts` (export) |
| `<a href>` and `location.href` | `context-footer.ts` (applet links), `input-router.ts` (3) |
| History URLs | `router.ts`, `applet-runtime.ts`, `chat-view-controller.ts`. They build from `window.location.href`, which already carries the prefix; verify each keeps the path rather than resetting to `/` |
| Pager page | `public/pager.html`: the icon link becomes relative and the session link uses `CACO_BASE`. Its fetches stay absolute; the injected wrapper covers them |
| Built-in applets | Every root-absolute `'/api/...'`, `'/themes/...'` and `'/?...'` literal under `applets/` becomes relative (`'api/...'`, `'?...'`). Applets run in the main page, whose document path is always the base, so a relative URL resolves the same at `/` and, through `<base href>`, under a prefix |
| Server output | `res.redirect('/...')` in `server.ts` (OAuth callback, legacy applet redirect) and any route that redirects: they redirect relative to the request's base path |

A unit test scans `public/ts/**/*.ts`, `public/*.html` and
`applets/**/*.{js,html,css}` for string literals that start with `"/`, `'/` or
`` `/ `` in `src=`, `href=`, `url(`, `import(`, `new WebSocket(`,
`location.href =` and `location.assign(`, and fails unless the line uses
`withBase` or `CACO_BASE`. It lists explicit exceptions. This keeps new code
from regressing the prefix.

**Browser storage.** Proxied instances share the hub's origin, so storage
collides. A helper `storageKey(key)` returns `key` when `BASE` is `/`
(unchanged) and `key@<BASE>` otherwise. Every key is classified:
- per instance (namespaced): `caco:collapsed-folders`, `ext:<slug>:<key>`;
- shared on purpose: `caco:theme`, panel widths (`panel-resizer.ts`), terminal
  height (`terminal-panel.ts`), debug state (`debug.ts`);
- the portal's own keys are unaffected.

The A6 test enumerates every `localStorage`/`sessionStorage` key in
`public/` and fails on an unclassified one.

**Same-origin guard and CSP.** Unchanged in Phase A.

### Phase B: hub proxy

Route `app.use('/peer/:key', ...)`, mounted **before the body parsers**
(`express.json()` and `express.urlencoded()`), static files and
`requireSameOrigin`, so request bodies stream to the peer untouched. It runs its
own checks. Caco's own WebSocket server moves to `noServer` mode, because `ws` attached to
the HTTP server answers 400 to every upgrade path it does not own. One `upgrade`
listener sends `/ws` to Caco and everything else to the proxy; it runs
`verifyWsUpgrade(origin, hubHost)` and destroys the socket when that fails. Built on Node's `http`/`https` (about 150 lines in `src/peer-proxy.ts`) rather
than `http-proxy`, which is unmaintained; the behaviour below is small enough
to own and test directly. Per request:

1. Refuse (400) a request that already carries `X-Caco-Base-Path`: no chaining.
2. Run the same-origin check against the hub (the browser must be the hub's own
   tab). Refuse with 403 otherwise.
3. Resolve the key to a proxyable peer by comparing with each peer's route key.
   Unknown or not proxyable: 404 with a short HTML message.
4. Strip `/peer/<key>` from the path (`/peer/k` alone redirects to `/peer/k/`).
5. Set `Host` to the peer's `host:port`. Set `Origin` to the peer's origin when
   the browser sent the hub's origin; drop it when absent. Remove `Cookie`,
   `Authorization`, and `X-Forwarded-*` from the browser. Set
   `X-Caco-Base-Path: /peer/<key>/`.
6. Proxy, streaming both ways, with no body buffering (exports and imports are
   large). Rewrite a response `Location` header that is a path to add the prefix.
   On a connection error: 502 with a short message.

The peer sees a request that is indistinguishable from the laptop's own browser
on `localhost:5300x`, so its same-origin guard passes with no change.

### Phase C: portal and merged pager

- Each portal iframe for a proxyable peer uses its `proxyPath`. The local
  instance keeps `/`. This holds on the laptop too: one code path. A peer that
  is not proxyable keeps its raw URL, as today.
- All proxied frames share the hub origin, so every portal `message` handler
  (status, navigation, drag and drop, and the merged pager) identifies the
  sender by `e.source === iframe.contentWindow`, never by origin, and posts to
  the hub origin. The bridge's allowed-origin check is satisfied because the
  frames are same-origin.
- Session transfer (export from one peer, import into another) goes through
  each peer's `proxyPath` instead of its raw origin.
- Favicons use `<proxyPath>api/favicon`.

## Invariants

1. With base path `/`, every response and every URL the client builds is
   identical to today (Phase A is a no-op locally).
2. The proxy reaches only peers from `getPeers()` that pass the overview origin
   rule.
3. The proxy serves only the hub's own same-origin browser requests.
4. A proxied request never carries the browser's cookies, authorization or
   forwarded headers to the peer.
5. `X-Caco-Base-Path` affects only how a page renders, never routing or
   authorization, and a request that already carries it is not proxied again.
6. Every server-side feature (overview, peer tools) keeps using peer origins
   directly; nothing server side depends on the proxy.

## Considerations

- **Applets and extensions.** Their `fetch` calls are covered by the wrapper.
  Absolute `src`/`href` in applet HTML, or dynamic `import('/...')` in an
  extension, are not; document that applet and extension authors should use
  relative URLs or `window.CACO_BASE`. Built-in applets get checked in Phase A.
- **MCP OAuth.** Redirect URIs point at the peer's own origin; signing in to an
  MCP server through a proxied iframe will not work. Out of scope; do it on the
  machine or through its own tunnel.
- **Tunnel login.** Everything is one origin through one tunnel, so the tunnel's
  login cookie applies to every frame. This is the reason for option B.
- **Performance.** Extra hop on the laptop for each request and WebSocket frame;
  negligible against devtunnel latency.
- **Restarts.** A peer restarting drops its proxied WebSocket; the client's
  existing reconnect handles it.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Phase A breaks local features | No-op when `BASE` is `/` (wrapper not installed); full unit suite; a prefixed end-to-end test; manual smoke on all three instances before Phase B |
| A missed absolute URL breaks one feature under the proxy | Lint-style test for raw absolute URLs; the fetch wrapper covers the long tail |
| The proxy becomes a way for a foreign page to drive peers | Same-origin check on the hub before proxying (Invariant 3); peers only from the vetted list |
| Header spoofing (`X-Caco-Base-Path`) | Display-only, pattern-validated, and chaining refused |
| localStorage bleed between instances | Namespaced keys under a prefix |

## Acceptance

| # | Criterion |
|---|---|
| A1 | `withBase`: `/api/x` gets the prefix; `api/x`, `//h/x`, `http://h/x`, `data:`, `blob:` unchanged; a path already under the base is unchanged; base `/` returns input unchanged |
| A2 | Fetch wrapper: not installed when base is `/`; prefixes same-origin absolute paths for string, `URL` and `Request` inputs; never double-prefixes; a rewritten `Request` keeps method, headers, body and signal; leaves cross-origin and relative ones alone |
| A3 | Server: `/` and `/pager.html` inject `CACO_BASE`, `<base href>` and the wrapper script first, from a valid header; an invalid or absent header gives `/`; `Cache-Control: no-store`; server redirects keep the base path |
| A4 | Every site in the Phase A table, including `pager.html` and built-in applets, uses `withBase` or `CACO_BASE`; the raw-absolute-URL test passes and fails when a raw literal is added |
| A5 | Prefixed end-to-end test: a test proxy strips `/peer/t` and sets the header in front of a real Caco test server; the main page, the pager page and a built-in applet load; `/api/sessions`, a JSON POST and the WebSocket work under the prefix |
| A6 | Every storage key is classified; per-instance keys are unchanged under `/` and suffixed under a prefix |
| A7 | Hub proxy: unknown key 404; not proxyable 404; foreign Origin 403 for HTTP and for a WebSocket upgrade; existing `X-Caco-Base-Path` 400; headers rewritten per Design step 5; `Location` rewritten; a JSON POST and a large upload stream through unchanged; WebSocket upgrade proxied; peer down 502 |
| A8 | Portal: proxyable peer iframes and favicons use `proxyPath`, others the raw URL; status, navigation and the merged pager identify the sending frame by source window; actions reach the right instance; a session transfer between two proxied peers works |
| A9 | Manual: from a second device over the laptop's tunnel, open the portal, use a devbox instance (send a message, open an applet), and use the merged pager |

## Plan

| Phase | Work | Files |
|---|---|---|
| A1 | `base-path.ts` (`BASE`, `withBase`, `installFetchBase`, `storageKey`) and tests (A1, A2) | `public/ts/base-path.ts`, tests |
| A2 | Server injection (base, `<base href>`, wrapper script) for `/` and `/pager.html`; relative asset URLs in HTML; base-aware redirects (A3) | `server.ts`, `public/index.html`, `public/pager.html`, tests |
| A3 | Convert the non-fetch sites in `public/ts`, `pager.html` and built-in applets; raw-URL test; storage classification (A4, A6) | `websocket.ts`, `extension-loader.ts`, `main.ts`, `session-panel.ts`, `context-footer.ts`, `command-registry.ts`, `input-router.ts`, router files, `terminal-panel.ts`, `debug.ts`, `public/pager.html`, `applets/**`, tests |
| A4 | Prefixed end-to-end test; deploy to all three instances; manual smoke at `/` (A5) | tests |
| B | Hub proxy with WebSocket upgrade, mounted before body parsers; `noServer` upgrade routing; proxyable-peer predicate; `proxyPath` on `GET /api/peers` (A7) | `src/peer-proxy.ts`, `src/routes/websocket.ts`, `server.ts`, `src/routes/sessions.ts`, tests |
| C | Portal iframes, favicons, every message handler, transfers and the merged pager use proxied paths and source-window matching (A8); docs; manual phone test (A9) | `public/portal.html`, `public/ts/portal-pager.ts`, `public/ts/pager-bridge.ts`, `README.md`, `API.md` |

Phase A is complete and shippable on its own; B and C start only after A4's
smoke passes on all three instances.

## Rationale

Decisions from Carl (2026-11-24): option B (single-port proxy) over option A
(each instance's public tunnel URL in its iframe), because A depends on
third-party login cookies inside iframes on mobile browsers. Path prefixing is
a separate first phase because the main risk is breaking local features. Only
three active users, so now is the time to make it future-proof.

Review (gpt-5.6-sol-fast, 2026-11-24) changes folded in: the proxy is mounted
before the body parsers; route keys are base64url of the full origin; Phase A
covers `pager.html`, built-in applets and server redirects, and the wrapper is
injected inline so the pager gets it; every portal message handler and session
transfers move to source-window matching and proxied paths; WebSocket upgrades
get the same-origin check; one `isProxyablePeer` predicate; the fetch wrapper is
idempotent; every storage key is classified.

Alternatives considered:
- **Routing absolute requests by `Referer`.** Avoids client changes, but
  WebSocket upgrades and some requests do not carry a reliable `Referer`.
- **Service worker that rewrites requests.** Does not see WebSocket
  connections, adds a registration and reload handshake, and needs a secure
  context.
- **A subdomain per peer.** Not available through a single tunnel URL.
- **Proxy that rewrites HTML and JS responses.** Brittle against minified
  bundles and user applets.
