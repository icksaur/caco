/**
 * Pager bridge (docs/spec-portal-pager.md).
 *
 * Shared protocol for the merged portal pager, plus the INSTANCE side: when this
 * Caco UI runs inside a portal iframe, it answers pager requests from the portal
 * by doing the HTTP work on its own origin, where its auth cookies live.
 */

export const BRIDGE = {
  WATCH: 'caco:pager:watch',
  VIEW: 'caco:pager:view',
  ACTION: 'caco:pager:action',
  RESULT: 'caco:pager:result',
  REFUSED: 'caco:pager:refused',
} as const;

/** Feed stops if the portal has not renewed its watch in this long. */
export const WATCH_TTL_MS = 60_000;
const WAIT_MS = 10_000;
const MAX_TEXT = 100_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface WatchRequest { type: typeof BRIDGE.WATCH }
export interface ActionRequest {
  type: typeof BRIDGE.ACTION;
  reqId: string;
  action: 'send' | 'dismiss';
  sessionId: string;
  text?: string;
}
export type BridgeRequest = WatchRequest | ActionRequest;

export interface ActionResult {
  type: typeof BRIDGE.RESULT;
  reqId: string;
  ok: boolean;
  status: number;
  error?: string;
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function isValidReqId(id: unknown): id is string {
  return typeof id === 'string' && REQ_ID_RE.test(id);
}

/** Validate a portal -> instance message. Anything malformed is null and ignored. */
export function parseBridgeRequest(data: unknown): BridgeRequest | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type === BRIDGE.WATCH) return { type: BRIDGE.WATCH };
  if (d.type !== BRIDGE.ACTION) return null;
  if (!isValidReqId(d.reqId) || !isValidSessionId(d.sessionId)) return null;
  if (d.action === 'dismiss') {
    return { type: BRIDGE.ACTION, reqId: d.reqId, action: 'dismiss', sessionId: d.sessionId };
  }
  if (d.action === 'send') {
    if (typeof d.text !== 'string') return null;
    const text = d.text.trim();
    if (!text || text.length > MAX_TEXT) return null;
    return { type: BRIDGE.ACTION, reqId: d.reqId, action: 'send', sessionId: d.sessionId, text };
  }
  return null;
}

/** Normalize a URL or origin string to an exact origin, or null. */
export function originOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Own origin is always allowed (the local portal is same-origin). Others must be listed exactly. */
export function isAllowedParentOrigin(origin: string, ownOrigin: string, allowed: readonly string[]): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === ownOrigin) return true;
  return allowed.includes(origin);
}

/** The HTTP request that performs an action, the same one standalone pager.html makes. */
export function actionRequest(req: ActionRequest): { url: string; body: Record<string, unknown> } {
  const base = '/api/sessions/' + encodeURIComponent(req.sessionId);
  if (req.action === 'send') return { url: base + '/messages', body: { prompt: req.text } };
  return { url: base + '/pager-dismiss', body: {} };
}

interface BridgeWindow {
  parent: unknown;
  location: { origin: string };
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

interface PostTarget { postMessage(msg: unknown, targetOrigin: string): void }

export interface PagerBridgeDeps {
  win: BridgeWindow;
  allowed: readonly string[];
  fetchFn: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Install the instance-side responder. Returns a handle for tests. No-op traffic
 * until an allowed parent asks: a Caco UI not inside a portal never polls.
 */
export function installPagerBridge(deps: PagerBridgeDeps): { handle(e: MessageEvent): void; feedRunning(): boolean } {
  const { win, allowed, fetchFn } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const ownOrigin = win.location.origin;

  let lastWatch = 0;
  let parentOrigin: string | null = null;
  let running = false;

  function postParent(msg: unknown, origin: string): void {
    (win.parent as PostTarget).postMessage(msg, origin);
  }

  async function feed(): Promise<void> {
    running = true;
    let since: number | null = null;
    let backoff = 1000;
    try {
      while (now() - lastWatch < WATCH_TTL_MS && parentOrigin) {
        const url = '/api/pager?wait=' + (since === null ? 0 : WAIT_MS) + (since === null ? '' : '&since=' + since);
        try {
          const res = await fetchFn(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const view = await res.json() as { version?: unknown };
          const progressed = view.version !== since;
          since = typeof view.version === 'number' ? view.version : null;
          backoff = 1000;
          postParent({ type: BRIDGE.VIEW, view }, parentOrigin);
          // A repeated version means the server shed the long-poll; do not spin.
          if (!progressed) await sleep(1000);
        } catch {
          // Silence is the portal's offline signal; just back off and retry.
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 15_000);
          since = null;
        }
      }
    } finally {
      running = false;
    }
  }

  async function act(req: ActionRequest, origin: string): Promise<void> {
    const { url, body } = actionRequest(req);
    let result: ActionResult;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        result = { type: BRIDGE.RESULT, reqId: req.reqId, ok: true, status: res.status };
      } else {
        const data = await res.json().catch(() => ({})) as { error?: unknown };
        const error = typeof data.error === 'string' ? data.error.slice(0, 300) : 'HTTP ' + res.status;
        result = { type: BRIDGE.RESULT, reqId: req.reqId, ok: false, status: res.status, error };
      }
    } catch {
      result = { type: BRIDGE.RESULT, reqId: req.reqId, ok: false, status: 0, error: 'Network error' };
    }
    postParent(result, origin);
  }

  function handle(e: MessageEvent): void {
    if (e.source !== win.parent || win.parent === win) return;
    const req = parseBridgeRequest(e.data);
    if (!req) return;
    if (!isAllowedParentOrigin(e.origin, ownOrigin, allowed)) {
      // Carries no data; only lets the portal tell Carl which origin to allow.
      if (e.origin && e.origin !== 'null') postParent({ type: BRIDGE.REFUSED }, e.origin);
      return;
    }
    if (req.type === BRIDGE.WATCH) {
      lastWatch = now();
      parentOrigin = e.origin;
      if (!running) void feed();
      return;
    }
    void act(req, e.origin);
  }

  win.addEventListener('message', handle);
  return { handle, feedRunning: () => running };
}
