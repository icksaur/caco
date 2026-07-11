import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { MCPAuthState } from '../../src/storage.js';

const authMocks = vi.hoisted(() => {
  const authStore = { servers: {} as Record<string, MCPAuthState> };
  const listCliOAuthConfigs = vi.fn((): Array<{ serverUrl: string; clientId: string; hasTokens: boolean; tokenExpired: boolean }> => []);
  const serverIdFromUrl = vi.fn((url: string) => new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  const discoverOAuthMetadata = vi.fn();
  const getMcpAuth = vi.fn(() => authStore);
  const setMcpAuth = vi.fn((next: { servers: Record<string, MCPAuthState> }) => { authStore.servers = next.servers; });
  const getMcpServerAuth = vi.fn((serverId: string) => authStore.servers[serverId]);
  const updateMcpServerAuth = vi.fn((serverId: string, updater: (prev: MCPAuthState | undefined) => MCPAuthState) => {
    const next = updater(authStore.servers[serverId]);
    authStore.servers[serverId] = next;
    return next;
  });
  return { authStore, discoverOAuthMetadata, getMcpAuth, getMcpServerAuth, listCliOAuthConfigs, serverIdFromUrl, setMcpAuth, updateMcpServerAuth };
});

vi.mock('../../src/storage.js', () => ({ getMcpAuth: authMocks.getMcpAuth, setMcpAuth: authMocks.setMcpAuth, getMcpServerAuth: authMocks.getMcpServerAuth, updateMcpServerAuth: authMocks.updateMcpServerAuth }));
vi.mock('../../src/cli-oauth.js', () => ({ listCliOAuthConfigs: authMocks.listCliOAuthConfigs }));
vi.mock('../../src/mcp-discovery.js', () => ({ discoverOAuthMetadata: authMocks.discoverOAuthMetadata, serverIdFromUrl: authMocks.serverIdFromUrl }));
vi.mock('../../src/mcp-auth-service.js', () => ({ refreshAccessToken: vi.fn() }));

let server: Server;
let base: string;
const tokenRequests: Array<Record<string, string>> = [];

beforeAll(async () => {
  const { router } = await import('../../src/routes/mcp-auth.js');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post('/token', (req, res) => { tokenRequests.push(req.body as Record<string, string>); res.json({ access_token: 'access-123', refresh_token: 'refresh-123', expires_in: 60 }); });
  app.post('/token-fail', (_req, res) => { res.status(400).json({ error_description: 'token rejected' }); });
  app.post('/token-empty', (_req, res) => { res.json({}); });
  app.use('/api/mcp/auth', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/auth`;
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.authStore.servers = {};
  tokenRequests.length = 0;
  authMocks.listCliOAuthConfigs.mockReturnValue([]);
  authMocks.serverIdFromUrl.mockImplementation((url: string) => new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
});

const jsonPost = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function serverAuth(overrides: Partial<MCPAuthState> = {}): MCPAuthState {
  return { url: 'https://mcp.example.com/sse', authorizationEndpoint: 'https://auth.example.com/authorize', tokenEndpoint: `${base.replace('/api/mcp/auth', '')}/token`, clientId: 'client-1', scopes: ['read'], needsAuth: true, needsClientId: false, ...overrides };
}

async function startAuth(serverId: string): Promise<URL> {
  const res = await fetch(`${base}/start?server=${serverId}&origin=${encodeURIComponent('http://browser.example')}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = res.headers.get('location');
  expect(location).toEqual(expect.stringContaining('https://auth.example.com/authorize'));
  return new URL(location!);
}

describe('mcp auth route harness', () => {
  it('lists stored servers and persists CLI OAuth discoveries', async () => {
    authMocks.authStore.servers.existing = serverAuth({ clientId: undefined, needsClientId: true, expiresAt: 123 });
    authMocks.listCliOAuthConfigs.mockReturnValue([
      { serverUrl: 'https://existing.test/mcp', clientId: 'cli-client', hasTokens: true, tokenExpired: false },
      { serverUrl: 'https://new.test/mcp', clientId: 'new-client', hasTokens: false, tokenExpired: true },
    ]);
    authMocks.serverIdFromUrl.mockImplementation((url: string) => url.includes('existing') ? 'existing' : 'new');
    const res = await fetch(`${base}/servers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: expect.arrayContaining([
      expect.objectContaining({ id: 'existing', needsClientId: false, expiresAt: 123, error: null }),
      expect.objectContaining({ id: 'new', url: 'https://new.test/mcp', needsAuth: true, needsClientId: false }),
    ]) });
    expect(authMocks.setMcpAuth).toHaveBeenCalledWith(expect.objectContaining({ servers: expect.objectContaining({ existing: expect.objectContaining({ clientId: 'cli-client' }), new: expect.objectContaining({ clientId: 'new-client' }) }) }));
  });

  it('rejects start requests without a server parameter or known server', async () => {
    const missing = await fetch(`${base}/start`);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('Missing server parameter');
    const unknown = await fetch(`${base}/start?server=nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('Server &quot;nope&quot; not found');
  });

  it('discovers missing OAuth metadata before redirecting to the provider', async () => {
    authMocks.authStore.servers.discovered = serverAuth({ authorizationEndpoint: '', tokenEndpoint: '', clientId: undefined, scopes: [], needsClientId: true });
    authMocks.discoverOAuthMetadata.mockResolvedValue({ authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: `${base.replace('/api/mcp/auth', '')}/token`, scopes_supported: ['read', 'write'], client_id: 'registered-client', redirect_uris: ['https://not-local.example/callback'] });
    const authUrl = await startAuth('discovered');
    expect(authUrl.searchParams.get('client_id')).toBe('registered-client');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://browser.example/');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toBe('read write offline_access');
    expect(authMocks.updateMcpServerAuth).toHaveBeenCalledWith('discovered', expect.any(Function));
  });

  it('reports discovery failures and missing client IDs', async () => {
    authMocks.authStore.servers.broken = serverAuth({ authorizationEndpoint: '', clientId: undefined });
    authMocks.discoverOAuthMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));
    const broken = await fetch(`${base}/start?server=broken`);
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain('metadata unavailable');
    authMocks.authStore.servers.noClient = serverAuth({ clientId: undefined });
    authMocks.discoverOAuthMetadata.mockResolvedValueOnce({ authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: `${base.replace('/api/mcp/auth', '')}/token`, scopes_supported: ['read'] });
    const noClient = await fetch(`${base}/start?server=noClient`);
    expect(noClient.status).toBe(400);
    expect(await noClient.text()).toContain('requires a client_id');
  });

  it('validates callback query parameters and provider-side errors', async () => {
    const providerError = await fetch(`${base}/callback?error=access_denied&error_description=Denied`);
    expect(providerError.status).toBe(200);
    expect(await providerError.text()).toContain('Denied');
    const missing = await fetch(`${base}/callback?code=abc`);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('Missing code or state parameter');
    const invalid = await fetch(`${base}/callback?code=abc&state=not-real`);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('Invalid or expired state');
  });

  it('exchanges callback codes for tokens and persists successful auth', async () => {
    authMocks.authStore.servers.known = serverAuth();
    const authUrl = await startAuth('known');
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = await fetch(`${base}/callback?code=code-123&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('mcp-auth-complete');
    expect(tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', code: 'code-123', client_id: 'client-1', scope: 'read offline_access' });
    expect(authMocks.authStore.servers.known).toMatchObject({ token: 'access-123', refreshToken: 'refresh-123', needsAuth: false, error: undefined });
  });

  it('rejects callbacks whose pending state expired or lost its server', async () => {
    authMocks.authStore.servers.expiring = serverAuth();
    const expiringUrl = await startAuth('expiring');
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 180_000);
    const expired = await fetch(`${base}/callback?code=late&state=${expiringUrl.searchParams.get('state')}`);
    nowSpy.mockRestore();
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain('Authentication timed out');
    authMocks.authStore.servers.missingLater = serverAuth();
    const missingLaterUrl = await startAuth('missingLater');
    delete authMocks.authStore.servers.missingLater;
    const missingLater = await fetch(`${base}/callback?code=code&state=${missingLaterUrl.searchParams.get('state')}`);
    expect(missingLater.status).toBe(404);
    expect(await missingLater.text()).toContain('Server &quot;missingLater&quot; not found');
  });

  it('persists callback token-exchange failures on the server auth state', async () => {
    authMocks.authStore.servers.known = serverAuth({ tokenEndpoint: `${base.replace('/api/mcp/auth', '')}/token-fail` });
    const authUrl = await startAuth('known');
    const state = authUrl.searchParams.get('state');
    const callback = await fetch(`${base}/callback?code=bad-code&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('token rejected');
    expect(authMocks.authStore.servers.known).toMatchObject({ needsAuth: true, error: 'token rejected' });
  });

  it('persists malformed token responses as callback failures', async () => {
    authMocks.authStore.servers.known = serverAuth({ tokenEndpoint: `${base.replace('/api/mcp/auth', '')}/token-empty` });
    const authUrl = await startAuth('known');
    const state = authUrl.searchParams.get('state');
    const callback = await fetch(`${base}/callback?code=bad-code&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('No access_token in response');
    expect(authMocks.authStore.servers.known).toMatchObject({ needsAuth: true, error: 'No access_token in response' });
  });

  it('validates and persists config updates', async () => {
    const missing = await jsonPost('/config', {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: 'serverId required' });
    const unknown = await jsonPost('/config', { serverId: 'nope', clientId: 'x' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: 'Server not found' });
    authMocks.authStore.servers.known = serverAuth({ clientId: undefined, needsClientId: true });
    const setClient = await jsonPost('/config', { serverId: 'known', clientId: 'new-client' });
    expect(setClient.status).toBe(200);
    expect(await setClient.json()).toEqual({ ok: true });
    expect(authMocks.authStore.servers.known).toMatchObject({ clientId: 'new-client', needsClientId: false });
    const clearClient = await jsonPost('/config', { serverId: 'known', clientId: '' });
    expect(clearClient.status).toBe(200);
    expect(await clearClient.json()).toEqual({ ok: true });
    expect(authMocks.authStore.servers.known).toMatchObject({ clientId: null, needsClientId: true });
  });
});
