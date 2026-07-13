import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class BrowserBusyError extends Error {}
class NotConnectedError extends Error {}
class LaunchFailedError extends Error {
  diagnostics: string;

  constructor(message: string, diagnostics = '') {
    super(message);
    this.diagnostics = diagnostics;
  }
}

type ToolPayload = { ok: true; data: Record<string, unknown> } | { ok: false; reason: string; message: string; diagnostics?: string };

type ToolWithHandler = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;
};

const browser = vi.hoisted(() => {
  const handle = {
    screenshot: vi.fn(),
    click: vi.fn(),
    focus: vi.fn(),
    evaluate: vi.fn(),
    hover: vi.fn(),
    uploadFile: vi.fn(),
  };
  const page = {
    goto: vi.fn(),
    title: vi.fn(),
    url: vi.fn(),
    $: vi.fn(),
    accessibility: { snapshot: vi.fn() },
    screenshot: vi.fn(),
    viewport: vi.fn(),
    waitForSelector: vi.fn(),
    keyboard: {
      down: vi.fn(),
      press: vi.fn(),
      up: vi.fn(),
      type: vi.fn(),
    },
    select: vi.fn(),
    evaluate: vi.fn(),
  };
  return {
    handle,
    page,
    connection: { page, authRedirectTo: null as string | null, dialogOpen: false },
    getConnection: vi.fn(),
    invalidateConnection: vi.fn(),
    withMutex: vi.fn(),
    ensureRunning: vi.fn(),
    loadBrowserConfig: vi.fn(),
    formatSnapshot: vi.fn(),
    broadcastGlobalEvent: vi.fn(),
  };
});

vi.mock('@github/copilot-sdk', () => ({
  defineTool: (name: string, definition: Record<string, unknown>) => ({ name, ...definition }),
}));

vi.mock('../../src/browser-connection.js', () => ({
  getConnection: browser.getConnection,
  invalidateConnection: browser.invalidateConnection,
  withMutex: browser.withMutex,
  ensureRunning: browser.ensureRunning,
  BrowserBusyError,
  NotConnectedError,
  LaunchFailedError,
}));

vi.mock('../../src/browser-config.js', () => ({ loadBrowserConfig: browser.loadBrowserConfig }));
vi.mock('../../src/browser-snapshot.js', () => ({ formatSnapshot: browser.formatSnapshot }));
vi.mock('../../src/event-bus.js', () => ({ broadcastGlobalEvent: browser.broadcastGlobalEvent }));

let tools: ToolWithHandler[];
let screenshotDir: string;

function tool(name: string): ToolWithHandler {
  const found = tools.find(t => t.name === name);
  expect(found).toBeDefined();
  return found as ToolWithHandler;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolPayload> {
  const result = await tool(name).handler(args);
  return JSON.parse(result.textResultForLlm) as ToolPayload;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  screenshotDir = join(tmpdir(), '.test-browser-screenshots');
  rmSync(screenshotDir, { recursive: true, force: true });
  browser.getConnection.mockReset().mockResolvedValue(browser.connection);
  browser.invalidateConnection.mockReset();
  browser.withMutex.mockReset().mockImplementation(async (fn: () => Promise<unknown>) => fn());
  browser.ensureRunning.mockReset().mockResolvedValue({ running: true, endpoint: 'ws://browser' });
  browser.loadBrowserConfig.mockReset().mockReturnValue({
    defaultTimeoutMs: 1234,
    screenshotDir,
    evalEnabled: true,
    evalOriginAllowlist: ['https://allowed.test'],
  });
  browser.formatSnapshot.mockReset().mockReturnValue({ outline: '[1] button Submit', nodeCount: 1, truncated: false });
  browser.broadcastGlobalEvent.mockReset();
  browser.connection.authRedirectTo = null;
  browser.connection.dialogOpen = false;
  browser.page.goto.mockReset().mockResolvedValue({ status: () => 204 });
  browser.page.title.mockReset().mockResolvedValue('Page title');
  browser.page.url.mockReset().mockReturnValue('https://allowed.test/page');
  browser.page.$.mockReset().mockResolvedValue(browser.handle);
  browser.page.accessibility.snapshot.mockReset().mockResolvedValue({ role: 'RootWebArea' });
  browser.page.screenshot.mockReset().mockResolvedValue(Buffer.from('page-png'));
  browser.page.viewport.mockReset().mockReturnValue({ width: 800, height: 600 });
  browser.page.waitForSelector.mockReset().mockResolvedValue(browser.handle);
  browser.page.keyboard.down.mockReset().mockResolvedValue(undefined);
  browser.page.keyboard.press.mockReset().mockResolvedValue(undefined);
  browser.page.keyboard.up.mockReset().mockResolvedValue(undefined);
  browser.page.keyboard.type.mockReset().mockResolvedValue(undefined);
  browser.page.select.mockReset().mockResolvedValue(['one']);
  browser.page.evaluate.mockReset().mockResolvedValue(42);
  browser.handle.screenshot.mockReset().mockResolvedValue(Buffer.from('element-png'));
  browser.handle.click.mockReset().mockResolvedValue(undefined);
  browser.handle.focus.mockReset().mockResolvedValue(undefined);
  browser.handle.evaluate.mockReset().mockResolvedValue(false);
  browser.handle.hover.mockReset().mockResolvedValue(undefined);
  browser.handle.uploadFile.mockReset().mockResolvedValue(undefined);
  const mod = await import('../../src/browser-tools.js');
  tools = mod.createBrowserTools({ id: 'sess-1' }) as unknown as ToolWithHandler[];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(screenshotDir, { recursive: true, force: true });
});

describe('browser tool handlers', () => {
  it('exports the six browser tools in their public order', () => {
    expect(tools.map(t => t.name)).toEqual([
      'caco_browser_ensure_running',
      'caco_browser_navigate',
      'caco_browser_snapshot',
      'caco_browser_screenshot',
      'caco_browser_action',
      'caco_browser_eval',
    ]);
  });

  it('ensure_running returns the ensureRunning payload and requested mode', async () => {
    const payload = await callTool('caco_browser_ensure_running', { mode: 'headless' });
    expect(payload).toEqual({ ok: true, data: { running: true, endpoint: 'ws://browser' } });
    expect(browser.ensureRunning).toHaveBeenCalledWith('headless');
  });

  it('ensure_running maps launch failures with diagnostics', async () => {
    browser.ensureRunning.mockRejectedValue(new LaunchFailedError('cannot launch', 'stderr text'));
    const payload = await callTool('caco_browser_ensure_running');
    expect(payload).toEqual({ ok: false, reason: 'launch_failed', message: 'cannot launch', diagnostics: 'stderr text' });
  });

  it('navigate uses config timeout, maps networkidle, and returns final page metadata', async () => {
    const payload = await callTool('caco_browser_navigate', { url: 'https://example.test', waitUntil: 'networkidle' });
    expect(payload).toEqual({ ok: true, data: { title: 'Page title', finalUrl: 'https://allowed.test/page', status: 204 } });
    expect(browser.page.goto).toHaveBeenCalledWith('https://example.test', { waitUntil: 'networkidle2', timeout: 1234 });
  });

  it('navigate maps not_connected and invalidates the cached connection', async () => {
    browser.getConnection.mockRejectedValue(new NotConnectedError('cdp disconnected'));
    const payload = await callTool('caco_browser_navigate', { url: 'https://example.test' });
    expect(payload).toEqual({ ok: false, reason: 'not_connected', message: 'cdp disconnected' });
    expect(browser.invalidateConnection).toHaveBeenCalledOnce();
  });

  it('snapshot formats the accessibility tree for an optional root selector', async () => {
    const payload = await callTool('caco_browser_snapshot', { rootSelector: '#main', maxNodes: 10, interestingOnly: false });
    expect(payload).toEqual({
      ok: true,
      data: { outline: '[1] button Submit', nodeCount: 1, truncated: false, url: 'https://allowed.test/page', title: 'Page title' },
    });
    expect(browser.page.$).toHaveBeenCalledWith('#main');
    expect(browser.page.accessibility.snapshot).toHaveBeenCalledWith({ interestingOnly: false, root: browser.handle });
    expect(browser.formatSnapshot).toHaveBeenCalledWith({ role: 'RootWebArea' }, { maxNodes: 10 });
  });

  it('snapshot reports auth redirects before reading accessibility', async () => {
    browser.connection.authRedirectTo = 'https://login.test';
    const payload = await callTool('caco_browser_snapshot');
    expect(payload).toEqual({ ok: false, reason: 'auth_required', message: 'auth_required: https://login.test' });
    expect(browser.page.accessibility.snapshot).not.toHaveBeenCalled();
  });

  it('snapshot reports missing root selectors as not_found', async () => {
    browser.page.$.mockResolvedValue(null);
    const payload = await callTool('caco_browser_snapshot', { rootSelector: '#missing' });
    expect(payload).toEqual({ ok: false, reason: 'not_found', message: 'Selector not found: #missing' });
  });

  it('snapshot reports an open dialog with the retry message', async () => {
    browser.connection.dialogOpen = true;
    const payload = await callTool('caco_browser_snapshot');
    expect(payload).toEqual({ ok: false, reason: 'frame_dialog_open', message: 'A JS dialog is open; it will auto-dismiss shortly. Retry.' });
  });

  it('screenshot writes a page screenshot and returns viewport dimensions', async () => {
    const payload = await callTool('caco_browser_screenshot', { fullPage: true });
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error('screenshot failed');
    expect(payload.data.width).toBe(800);
    expect(payload.data.height).toBe(600);
    expect(String(payload.data.path)).toContain('.test-browser-screenshots/sess-1-');
    expect(existsSync(String(payload.data.path))).toBe(true);
    expect(browser.page.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
  });

  it('screenshot clips to an element or reports a missing selector', async () => {
    const clipped = await callTool('caco_browser_screenshot', { clipSelector: '.card' });
    expect(clipped.ok).toBe(true);
    expect(browser.handle.screenshot).toHaveBeenCalledWith({ type: 'png' });
    browser.page.$.mockResolvedValue(null);
    const missing = await callTool('caco_browser_screenshot', { clipSelector: '.missing' });
    expect(missing).toEqual({ ok: false, reason: 'not_found', message: 'Selector not found: .missing' });
  });

  it('action clicks selector targets', async () => {
    const payload = await callTool('caco_browser_action', { action: 'click', target: { selector: '#button' } });

    expect(payload).toEqual({ ok: true, data: { action: 'click', selector: '#button' } });
    expect(browser.page.waitForSelector).toHaveBeenCalledWith('#button', { timeout: 1234, visible: true });
    expect(browser.handle.click).toHaveBeenCalledTimes(1);
    expect(browser.handle.click).toHaveBeenCalledWith({ delay: 0 });
  });

  it('action replaces existing input text when typing', async () => {
    const payload = await callTool('caco_browser_action', { action: 'type', target: { selector: '#name' }, value: 'Ada' });

    expect(payload).toEqual({ ok: true, data: { action: 'type', selector: '#name' } });
    expect(browser.handle.focus).toHaveBeenCalledTimes(1);
    expect(browser.page.keyboard.down.mock.calls).toEqual([['Control']]);
    expect(browser.page.keyboard.press.mock.calls).toEqual([['A'], ['Backspace']]);
    expect(browser.page.keyboard.up.mock.calls).toEqual([['Control']]);
    expect(browser.page.keyboard.type.mock.calls).toEqual([['Ada']]);
    expect(browser.handle.click).not.toHaveBeenCalled();
  });

  it('action selects the requested option value', async () => {
    const payload = await callTool('caco_browser_action', { action: 'select', target: { selector: '#choice' }, value: 'b' });

    expect(payload).toEqual({ ok: true, data: { action: 'select', selector: '#choice' } });
    expect(browser.page.select).toHaveBeenCalledTimes(1);
    expect(browser.page.select).toHaveBeenCalledWith('#choice', 'b');
    expect(browser.handle.click).not.toHaveBeenCalled();
  });

  it('action toggles checkboxes only when their current state differs', async () => {
    browser.handle.evaluate.mockResolvedValue(false);
    const checked = await callTool('caco_browser_action', { action: 'check', target: { selector: '#agree' } });
    expect(checked).toEqual({ ok: true, data: { action: 'check', selector: '#agree' } });
    expect(browser.handle.evaluate).toHaveBeenCalledTimes(1);
    expect(browser.handle.click).toHaveBeenCalledTimes(1);

    browser.handle.evaluate.mockClear();
    browser.handle.click.mockClear();
    browser.handle.evaluate.mockResolvedValue(true);
    const unchecked = await callTool('caco_browser_action', { action: 'uncheck', target: { selector: '#agree' } });
    expect(unchecked).toEqual({ ok: true, data: { action: 'uncheck', selector: '#agree' } });
    expect(browser.handle.evaluate).toHaveBeenCalledTimes(1);
    expect(browser.handle.click).toHaveBeenCalledTimes(1);

    browser.handle.evaluate.mockClear();
    browser.handle.click.mockClear();
    browser.handle.evaluate.mockResolvedValue(true);
    const alreadyChecked = await callTool('caco_browser_action', { action: 'check', target: { selector: '#agree' } });
    expect(alreadyChecked).toEqual({ ok: true, data: { action: 'check', selector: '#agree' } });
    expect(browser.handle.click).not.toHaveBeenCalled();
  });

  it('action hovers and presses keyboard keys through the page', async () => {
    const hover = await callTool('caco_browser_action', { action: 'hover', target: { selector: '#menu' } });
    expect(hover).toEqual({ ok: true, data: { action: 'hover', selector: '#menu' } });
    expect(browser.handle.hover).toHaveBeenCalledTimes(1);
    expect(browser.page.keyboard.press).not.toHaveBeenCalled();

    browser.handle.hover.mockClear();
    const press = await callTool('caco_browser_action', { action: 'press_key', target: { selector: 'body' }, value: 'Enter' });
    expect(press).toEqual({ ok: true, data: { action: 'press_key', selector: 'body' } });
    expect(browser.page.keyboard.press.mock.calls).toEqual([['Enter']]);
    expect(browser.handle.hover).not.toHaveBeenCalled();
  });

  it('action uploads an existing file through the element handle', async () => {
    const uploadPath = join(tmpdir(), '.test-browser-upload.txt');
    writeFileSync(uploadPath, 'upload');
    try {
      const payload = await callTool('caco_browser_action', { action: 'upload', target: { selector: 'input' }, value: uploadPath });

      expect(payload).toEqual({ ok: true, data: { action: 'upload', selector: 'input' } });
      expect(browser.page.waitForSelector).toHaveBeenCalledWith('input', { timeout: 1234, visible: false });
      expect(browser.handle.uploadFile).toHaveBeenCalledTimes(1);
      expect(browser.handle.uploadFile).toHaveBeenCalledWith(uploadPath);
    } finally {
      rmSync(uploadPath, { force: true });
    }
  });

  it('action rejects id-only targets and missing upload files as invalid_args', async () => {
    const idOnly = await callTool('caco_browser_action', { action: 'click', target: { id: 7 } });
    expect(idOnly).toEqual({ ok: false, reason: 'invalid_args', message: 'invalid_args: v1 requires {selector}; {id} alone is not yet supported. Use snapshot to find a usable CSS selector.' });
    const missingUpload = await callTool('caco_browser_action', { action: 'upload', target: { selector: 'input' }, value: join(tmpdir(), '.missing-upload') });
    expect(missingUpload.ok).toBe(false);
    if (missingUpload.ok) throw new Error('upload unexpectedly succeeded');
    expect(missingUpload.reason).toBe('invalid_args');
    expect(missingUpload.message).toContain('upload file not found');
  });

  it('action maps browser_busy and open dialog failures', async () => {
    browser.getConnection.mockRejectedValueOnce(new BrowserBusyError('busy now'));
    const busy = await callTool('caco_browser_action', { action: 'click', target: { selector: '#button' } });
    expect(busy).toEqual({ ok: false, reason: 'browser_busy', message: 'busy now' });
    browser.getConnection.mockResolvedValue(browser.connection);
    browser.connection.dialogOpen = true;
    const dialog = await callTool('caco_browser_action', { action: 'click', target: { selector: '#button' } });
    expect(dialog).toEqual({ ok: false, reason: 'frame_dialog_open', message: 'A JS dialog is open; retry shortly.' });
  });

  it('eval returns evaluated JSON and broadcasts a bounded audit event', async () => {
    const payload = await callTool('caco_browser_eval', { expression: '1 + 1', timeoutMs: 50 });
    expect(payload).toEqual({ ok: true, data: { result: 42 } });
    expect(browser.broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'caco.browser.eval', data: { origin: 'https://allowed.test', expression: '1 + 1', sessionId: 'sess-1' } });
    expect(browser.page.evaluate).toHaveBeenCalledWith(expect.any(Function), '1 + 1');
  });

  it('eval can be disabled by config', async () => {
    browser.loadBrowserConfig.mockReturnValue({ defaultTimeoutMs: 1234, screenshotDir, evalEnabled: false, evalOriginAllowlist: [] });
    const payload = await callTool('caco_browser_eval', { expression: '1 + 1' });
    expect(payload).toEqual({ ok: false, reason: 'eval_disabled', message: 'caco_browser_eval is disabled. Set evalEnabled=true in browser-config.json to allow it.' });
    expect(browser.getConnection).not.toHaveBeenCalled();
  });

  it('eval blocks non-allowlisted origins before evaluating', async () => {
    browser.page.url.mockReturnValue('https://blocked.test/page');
    const payload = await callTool('caco_browser_eval', { expression: 'document.title' });
    expect(payload).toEqual({ ok: false, reason: 'eval_origin_blocked', message: 'eval_origin_blocked: https://blocked.test' });
    expect(browser.page.evaluate).not.toHaveBeenCalled();
  });

  it('eval maps timeout races without waiting for real time', async () => {
    vi.useFakeTimers();
    browser.page.evaluate.mockReturnValue(new Promise(() => {}));
    const pending = callTool('caco_browser_eval', { expression: 'slow()', timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const payload = await pending;
    expect(payload).toEqual({ ok: false, reason: 'timeout', message: 'Timeout' });
  });
});


