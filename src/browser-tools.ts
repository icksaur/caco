/**
 * Browser Tools
 *
 * Six caco_browser_* tools that drive an operator-launched Edge over CDP.
 * Spec: docs/spec-browser-automation.md
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { toPosix } from './path-utils.js';
import {
  getConnection,
  invalidateConnection,
  withMutex,
  ensureRunning,
  BrowserBusyError,
  NotConnectedError,
  LaunchFailedError,
} from './browser-connection.js';
import { loadBrowserConfig } from './browser-config.js';
import { formatSnapshot, type AxNode } from './browser-snapshot.js';
import { broadcastGlobalEvent } from './event-bus.js';
import type { SessionEvent } from './event-bus.js';
import type { SessionIdRef } from './types.js';

type ErrorReason =
  | 'not_connected'
  | 'launch_failed'
  | 'not_found'
  | 'not_visible'
  | 'timeout'
  | 'auth_required'
  | 'browser_busy'
  | 'eval_disabled'
  | 'eval_origin_blocked'
  | 'eval_error'
  | 'frame_dialog_open'
  | 'invalid_args';

function ok<T>(data: T) {
  return { textResultForLlm: JSON.stringify({ ok: true, data }), resultType: 'success' as const };
}

function fail(reason: ErrorReason, message: string, extra: Record<string, unknown> = {}) {
  return {
    textResultForLlm: JSON.stringify({ ok: false, reason, message, ...extra }),
    resultType: 'error' as const,
  };
}

async function tryToolBody<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; reason: ErrorReason; message: string; diagnostics?: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof BrowserBusyError) return { ok: false, reason: 'browser_busy', message: err.message };
    if (err instanceof NotConnectedError) {
      invalidateConnection();
      return { ok: false, reason: 'not_connected', message: err.message };
    }
    if (err instanceof LaunchFailedError) return { ok: false, reason: 'launch_failed', message: err.message, diagnostics: err.diagnostics };
    if (err instanceof AuthRequiredError) return { ok: false, reason: 'auth_required', message: err.message };
    if (err instanceof NotFoundError) return { ok: false, reason: 'not_found', message: err.message };
    if (err instanceof EvalOriginBlockedError) return { ok: false, reason: 'eval_origin_blocked', message: err.message };
    const msg = (err as Error).message;
    if (msg.includes('Timeout') || msg.includes('timed out')) return { ok: false, reason: 'timeout', message: msg };
    if (msg.startsWith('invalid_args')) return { ok: false, reason: 'invalid_args', message: msg };
    if (msg.includes('frame_dialog_open')) return { ok: false, reason: 'frame_dialog_open', message: msg };
    return { ok: false, reason: 'eval_error', message: msg };
  }
}

class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}
class AuthRequiredError extends Error {
  constructor(public url: string) { super(`auth_required: ${url}`); this.name = 'AuthRequiredError'; }
}
class EvalOriginBlockedError extends Error {
  constructor(origin: string) { super(`eval_origin_blocked: ${origin}`); this.name = 'EvalOriginBlockedError'; }
}

async function checkAuthRequired(): Promise<{ blocked: true; url: string } | { blocked: false }> {
  const conn = await getConnection();
  if (conn.authRedirectTo) return { blocked: true, url: conn.authRedirectTo };
  return { blocked: false };
}

async function checkDialogOpen(): Promise<boolean> {
  const conn = await getConnection();
  return conn.dialogOpen;
}

export function createBrowserTools(sessionRef: SessionIdRef | undefined) {
  const ensureToolRunning = defineTool('caco_browser_ensure_running', {
    description: 'Ensure the Caco-controlled Edge browser is running and CDP-reachable. Idempotent; call once before other caco_browser_* tools, and again on not_connected to recover.',
    parameters: z.object({
      mode: z.enum(['visible', 'hidden', 'headless']).optional().describe('First-launch window mode (ignored if already running). Default visible.'),
    }),
    handler: async ({ mode }) => {
      const result = await tryToolBody(() => ensureRunning(mode ?? 'visible'));
      if (result.ok) return ok(result.data);
      return fail(result.reason, result.message, { diagnostics: result.diagnostics });
    },
  });

  const navigate = defineTool('caco_browser_navigate', {
    description: 'Navigate the working tab to a URL (follows redirects). Returns final URL and page title.',
    parameters: z.object({
      url: z.string().url(),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe("Completion condition. Default 'load'."),
      timeoutMs: z.number().positive().optional(),
    }),
    handler: async ({ url, waitUntil, timeoutMs }) => {
      const config = loadBrowserConfig();
      const t = timeoutMs ?? config.defaultTimeoutMs;
      const result = await tryToolBody(() => withMutex(async () => {
        const conn = await getConnection();
        if (conn.dialogOpen) throw new Error('frame_dialog_open');
        const wait = waitUntil === 'networkidle' ? 'networkidle2' : waitUntil ?? 'load';
        const response = await conn.page.goto(url, { waitUntil: wait as 'load', timeout: t });
        const title = await conn.page.title();
        return {
          title,
          finalUrl: conn.page.url(),
          status: response?.status() ?? null,
        };
      }, config.defaultTimeoutMs));
      if (!result.ok) return fail(result.reason, result.message);
      return ok(result.data);
    },
  });

  const snapshot = defineTool('caco_browser_snapshot', {
    description: 'Read the accessibility tree of the working tab as a numbered outline; each [N] is an id for caco_browser_action target.id. Re-snapshot after any state change since ids re-number.',
    parameters: z.object({
      rootSelector: z.string().optional().describe('CSS selector to restrict to a subtree.'),
      maxNodes: z.number().int().positive().max(1000).optional().describe('Max elements. Default 200.'),
      interestingOnly: z.boolean().optional().describe('Default true (drops presentational nodes).'),
    }),
    handler: async ({ rootSelector, maxNodes, interestingOnly }) => {
      const config = loadBrowserConfig();
      const result = await tryToolBody(() => withMutex(async () => {
        const auth = await checkAuthRequired();
        if (auth.blocked) throw new AuthRequiredError(auth.url);
        if (await checkDialogOpen()) throw new Error('frame_dialog_open');

        const conn = await getConnection();
        let rootHandle: unknown;
        if (rootSelector) {
          rootHandle = await conn.page.$(rootSelector);
          if (!rootHandle) throw new NotFoundError(`Selector not found: ${rootSelector}`);
        }
        const ax = await conn.page.accessibility.snapshot({
          interestingOnly: interestingOnly ?? true,
          // @ts-expect-error puppeteer-core types accept ElementHandle | null
          root: rootHandle ?? undefined,
        });
        const formatted = formatSnapshot(ax as AxNode | null, { maxNodes });
        return {
          outline: formatted.outline,
          nodeCount: formatted.nodeCount,
          truncated: formatted.truncated,
          url: conn.page.url(),
          title: await conn.page.title(),
        };
      }, config.defaultTimeoutMs));
      if (!result.ok) {
        if (result.message.includes('frame_dialog_open')) return fail('frame_dialog_open', 'A JS dialog is open; it will auto-dismiss shortly. Retry.');
        return fail(result.reason, result.message);
      }
      return ok(result.data);
    },
  });

  const screenshot = defineTool('caco_browser_screenshot', {
    description: 'Capture a PNG screenshot of the working tab; returns the saved absolute path. Show it to the operator via a files applet link (?applet=files&openPath=<path>).',
    parameters: z.object({
      fullPage: z.boolean().optional().describe('Default false (viewport only).'),
      clipSelector: z.string().optional().describe('CSS selector to clip to.'),
    }),
    handler: async ({ fullPage, clipSelector }) => {
      const config = loadBrowserConfig();
      const result = await tryToolBody(() => withMutex(async () => {
        const conn = await getConnection();
        mkdirSync(config.screenshotDir, { recursive: true });
        const sid = sessionRef?.id ?? 'unknown';
        const path = join(config.screenshotDir, `${sid}-${Date.now()}.png`);
        let buffer: Buffer;
        if (clipSelector) {
          const el = await conn.page.$(clipSelector);
          if (!el) throw new NotFoundError(`Selector not found: ${clipSelector}`);
          buffer = Buffer.from(await el.screenshot({ type: 'png' }) as Uint8Array);
        } else {
          buffer = Buffer.from(await conn.page.screenshot({ type: 'png', fullPage: fullPage ?? false }) as Uint8Array);
        }
        writeFileSync(path, buffer);
        const viewport = conn.page.viewport();
        return { path: toPosix(path), width: viewport?.width ?? 0, height: viewport?.height ?? 0 };
      }, config.defaultTimeoutMs));
      if (!result.ok) return fail(result.reason, result.message);
      return ok(result.data);
    },
  });

  const action = defineTool('caco_browser_action', {
    description: 'Perform a UI action on the working tab. target is {id: N} from the latest snapshot or {selector: "..."} (Shadow DOM uses ">>>").',
    parameters: z.object({
      action: z.enum(['click', 'type', 'select', 'check', 'uncheck', 'hover', 'press_key', 'upload']),
      target: z.object({
        id: z.number().int().positive().optional(),
        selector: z.string().optional(),
      }).refine((t) => t.id !== undefined || t.selector !== undefined, { message: 'target must have id or selector' }),
      value: z.string().optional().describe('For type/select/press_key (key name) / upload (file path).'),
      timeoutMs: z.number().positive().optional(),
    }),
    handler: async ({ action: verb, target, value, timeoutMs }) => {
      const config = loadBrowserConfig();
      const t = timeoutMs ?? config.defaultTimeoutMs;
      const result = await tryToolBody(() => withMutex(async () => {
        const auth = await checkAuthRequired();
        if (auth.blocked) throw new AuthRequiredError(auth.url);
        if (await checkDialogOpen()) throw new Error('frame_dialog_open');

        const conn = await getConnection();
        // v1 ids are not yet wired to a stable map; require selector for now.
        // The agent typically does snapshot → action by selector, which works
        // because the outline includes role+name+attributes for the agent to
        // build a selector. Id-based addressing is a v1.1 enhancement.
        if (target.id !== undefined && !target.selector) {
          throw new Error('invalid_args: v1 requires {selector}; {id} alone is not yet supported. Use snapshot to find a usable CSS selector.');
        }
        const selector = target.selector!;
        const handle = await conn.page.waitForSelector(selector, { timeout: t, visible: verb !== 'upload' });
        if (!handle) throw new NotFoundError(`Selector not found: ${selector}`);

        switch (verb) {
          case 'click':
            await handle.click({ delay: 0 });
            break;
          case 'type':
            if (value === undefined) throw new Error('invalid_args: type requires value');
            await handle.focus();
            await conn.page.keyboard.down('Control');
            await conn.page.keyboard.press('A');
            await conn.page.keyboard.up('Control');
            await conn.page.keyboard.press('Backspace');
            await conn.page.keyboard.type(value);
            break;
          case 'select':
            if (value === undefined) throw new Error('invalid_args: select requires value');
            await conn.page.select(selector, value);
            break;
          case 'check':
          case 'uncheck': {
            const checked = await handle.evaluate((el) => (el as HTMLInputElement).checked);
            const want = verb === 'check';
            if (checked !== want) await handle.click({ delay: 0 });
            break;
          }
          case 'hover':
            await handle.hover();
            break;
          case 'press_key':
            if (value === undefined) throw new Error('invalid_args: press_key requires value');
            await conn.page.keyboard.press(value as never);
            break;
          case 'upload':
            if (value === undefined) throw new Error('invalid_args: upload requires value (absolute path)');
            if (!existsSync(value)) throw new Error(`invalid_args: upload file not found: ${value}`);
            await (handle as { uploadFile(...paths: string[]): Promise<void> }).uploadFile(value);
            break;
        }
        return { action: verb, selector };
      }, config.defaultTimeoutMs));
      if (!result.ok) {
        if (result.message.startsWith('invalid_args')) return fail('invalid_args', result.message);
        if (result.message.includes('frame_dialog_open')) return fail('frame_dialog_open', 'A JS dialog is open; retry shortly.');
        return fail(result.reason, result.message);
      }
      return ok(result.data);
    },
  });

  const evalTool = defineTool('caco_browser_eval', {
    description: 'Escape-hatch: evaluate a JS expression in the working tab; returns JSON. Disabled unless evalEnabled + origin allowlisted in browser-config.json. Prefer caco_browser_action/snapshot.',
    parameters: z.object({
      expression: z.string().describe('JS expression; wrap multi-statement in (() => { ...; return ...; })().'),
      timeoutMs: z.number().positive().optional(),
    }),
    handler: async ({ expression, timeoutMs }) => {
      const config = loadBrowserConfig();
      if (!config.evalEnabled) {
        return fail('eval_disabled', 'caco_browser_eval is disabled. Set evalEnabled=true in browser-config.json to allow it.');
      }
      const t = timeoutMs ?? config.defaultTimeoutMs;
      const result = await tryToolBody(() => withMutex(async () => {
        const conn = await getConnection();
        const origin = (() => {
          try { return new URL(conn.page.url()).origin; } catch { return null; }
        })();
        if (!origin || !config.evalOriginAllowlist.includes(origin)) {
          throw new EvalOriginBlockedError(origin ?? '(unknown)');
        }
        broadcastGlobalEvent({ type: 'caco.browser.eval', data: { origin, expression: expression.slice(0, 200), sessionId: sessionRef?.id } } as SessionEvent);
        const result = await Promise.race([
          conn.page.evaluate((expr: string) => {
            const fn = new Function(`return (${expr});`) as () => unknown;
            return fn();
          }, expression),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), t)),
        ]);
        return { result };
      }, config.defaultTimeoutMs));
      if (!result.ok) {
        if (result.message.includes('eval_origin_blocked')) return fail('eval_origin_blocked', result.message);
        return fail(result.reason, result.message);
      }
      return ok(result.data);
    },
  });

  return [ensureToolRunning, navigate, snapshot, screenshot, action, evalTool];
}
