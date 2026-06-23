import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireSameOrigin } from '../../src/security/same-origin.js';

function mockReq(method: string, path: string, headers: Record<string, string | undefined>): Request {
  return { method, path, headers } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe('requireSameOrigin middleware', () => {
  it('passes a same-origin loopback request', () => {
    const next = vi.fn();
    const { res, status } = mockRes();
    requireSameOrigin(
      mockReq('POST', '/api/shell', { origin: 'http://localhost:53000', host: 'localhost:53000' }),
      res, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin POST with 403 (command never runs)', () => {
    const next = vi.fn();
    const { res, status, json } = mockRes();
    requireSameOrigin(
      mockReq('POST', '/api/shell', { origin: 'http://evil.example', host: 'localhost:53000' }),
      res, next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalled();
  });

  it('passes an Origin-less request (server self-call / navigation)', () => {
    const next = vi.fn();
    const { res, status } = mockRes();
    requireSameOrigin(
      mockReq('POST', '/api/sessions/abc/messages', { host: 'localhost:53000' }),
      res, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('passes the portal import carve-out even with a foreign Origin', () => {
    const next = vi.fn();
    const { res, status } = mockRes();
    requireSameOrigin(
      mockReq('POST', '/api/sessions/import', { origin: 'http://localhost:9999', host: 'localhost:53000' }),
      res, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('passes the portal export carve-out even with a foreign Origin', () => {
    const next = vi.fn();
    const { res, status } = mockRes();
    requireSameOrigin(
      mockReq('GET', '/api/sessions/11111111-1111-4111-8111-111111111111/export', {
        origin: 'http://localhost:9999', host: 'localhost:53000',
      }),
      res, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a DNS-rebinding request (origin==host but untrusted)', () => {
    const next = vi.fn();
    const { res, status } = mockRes();
    requireSameOrigin(
      mockReq('POST', '/api/shell', { origin: 'http://evil.example:53000', host: 'evil.example:53000' }),
      res, next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
