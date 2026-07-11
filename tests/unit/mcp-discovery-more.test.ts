import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiscoveryCache, discoverOAuthMetadata, serverIdFromUrl } from '../../src/mcp-discovery.js';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function emptyResponse(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

describe('serverIdFromUrl more URL cases', () => {
  it.each([
    ['https://api.example.com/mcp?tenant=a#fragment', 'api-example-com'],
    ['http://sub.domain.example.org:8080/path', 'sub-domain-example-org'],
    ['https://localhost/sse', 'localhost'],
    ['http://127.0.0.1:3333/mcp', '127-0-0-1'],
    ['https://MiXeD.Example.COM/path', 'mixed-example-com'],
  ])('converts only the parsed hostname for %s', (url, expected) => {
    expect(serverIdFromUrl(url)).toBe(expected);
  });
});

describe('discoverOAuthMetadata', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearDiscoveryCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearDiscoveryCache();
    vi.unstubAllGlobals();
  });

  it('discovers metadata through the MCP protected-resource flow and caches it', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' }))
      .mockResolvedValueOnce(jsonResponse({ scopes_supported: ['read', 'write'], authorization_servers: ['https://auth.example.com/'] }))
      .mockResolvedValueOnce(jsonResponse({ issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', registration_endpoint: 'https://auth.example.com/register' }))
      .mockResolvedValueOnce(jsonResponse({ client_id: 'client-1', redirect_uris: ['http://localhost/callback'] }));

    const first = await discoverOAuthMetadata('https://mcp.example.com/sse');
    const second = await discoverOAuthMetadata('https://mcp.example.com/sse');

    expect(first).toEqual({
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes_supported: ['read', 'write'],
      client_id: 'client-1',
      redirect_uris: ['http://localhost/callback'],
      registration_endpoint: 'https://auth.example.com/register',
    });
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe('https://auth.example.com/.well-known/openid-configuration');
  });

  it('uses the default registration URL and registration scope when resource scopes are absent', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/resource"' }))
      .mockResolvedValueOnce(jsonResponse({ authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(jsonResponse({ authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token' }))
      .mockResolvedValueOnce(jsonResponse({ client_id: 'client-2', scope: 'mcp:all' }));

    await expect(discoverOAuthMetadata('https://mcp.example.com/mcp')).resolves.toMatchObject({
      client_id: 'client-2',
      scopes_supported: ['mcp:all'],
      registration_endpoint: 'https://mcp.example.com/register',
    });
  });

  it('still returns MCP metadata when optional dynamic registration fails', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/resource"' }))
      .mockResolvedValueOnce(jsonResponse({ scopes_supported: ['read'], authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(jsonResponse({ authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token' }))
      .mockRejectedValueOnce(new Error('registration offline'));

    await expect(discoverOAuthMetadata('https://mcp.example.com/mcp')).resolves.toEqual({
      issuer: undefined,
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes_supported: ['read'],
    });
  });

  it('falls back to RFC 8414 metadata after a non-401 probe', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404))
      .mockResolvedValueOnce(jsonResponse({ issuer: 'https://mcp.example.com', authorization_endpoint: 'https://mcp.example.com/oauth/authorize', token_endpoint: 'https://mcp.example.com/oauth/token', scopes_supported: ['profile'], client_id: 'static-client' }));

    await expect(discoverOAuthMetadata('https://mcp.example.com/sse')).resolves.toEqual({
      issuer: 'https://mcp.example.com',
      authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
      token_endpoint: 'https://mcp.example.com/oauth/token',
      scopes_supported: ['profile'],
      client_id: 'static-client',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://mcp.example.com/.well-known/oauth-authorization-server');
  });

  it('falls back from malformed RFC metadata to OIDC metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404))
      .mockResolvedValueOnce(jsonResponse({ authorization_endpoint: 'missing-token' }))
      .mockResolvedValueOnce(jsonResponse({ authorization_endpoint: 'https://mcp.example.com/oidc/authorize', token_endpoint: 'https://mcp.example.com/oidc/token' }));

    await expect(discoverOAuthMetadata('https://mcp.example.com/sse')).resolves.toEqual({
      issuer: undefined,
      authorization_endpoint: 'https://mcp.example.com/oidc/authorize',
      token_endpoint: 'https://mcp.example.com/oidc/token',
      scopes_supported: undefined,
      client_id: undefined,
    });
  });

  it('throws when MCP, RFC, and OIDC discovery all fail', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));

    await expect(discoverOAuthMetadata('https://mcp.example.com/sse')).rejects.toThrow('OAuth discovery failed for https://mcp.example.com/sse: No metadata found');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed MCP resource metadata and continues to fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/resource"' }))
      .mockResolvedValueOnce(jsonResponse({ scopes_supported: ['read'] }))
      .mockResolvedValueOnce(emptyResponse(404))
      .mockResolvedValueOnce(jsonResponse({ authorization_endpoint: 'https://mcp.example.com/authorize', token_endpoint: 'https://mcp.example.com/token' }));

    await expect(discoverOAuthMetadata('https://mcp.example.com/sse')).resolves.toMatchObject({
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
    });
  });
});
