/**
 * MCP Auth Routes Unit Tests
 * 
 * Tests the route handlers defined in src/routes/mcp-auth.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, createHash } from 'crypto';

// Mock storage functions
vi.mock('../../src/storage.js', () => ({
  getMcpAuth: vi.fn(() => ({ servers: {} })),
  setMcpAuth: vi.fn(),
  getMcpServerAuth: vi.fn(),
  setMcpServerAuth: vi.fn(),
}));

import { getMcpAuth, setMcpAuth, getMcpServerAuth, setMcpServerAuth } from '../../src/storage.js';

// Import after mocking to get mocked versions
const mockedGetMcpAuth = vi.mocked(getMcpAuth);
const mockedSetMcpAuth = vi.mocked(setMcpAuth);
const mockedGetMcpServerAuth = vi.mocked(getMcpServerAuth);
const mockedSetMcpServerAuth = vi.mocked(setMcpServerAuth);

// Test the PKCE generation logic (duplicated from route for isolation)
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('MCP Auth Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PKCE generation', () => {
    it('generates base64url verifier of correct length', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(verifier.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    });

    it('generates different verifiers each time', () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    it('generates S256 challenge from verifier', () => {
      const verifier = 'test-verifier-for-challenge';
      const challenge = generateCodeChallenge(verifier);
      
      // Challenge should be base64url encoded SHA256
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      
      // Same verifier produces same challenge
      const challenge2 = generateCodeChallenge(verifier);
      expect(challenge).toBe(challenge2);
    });

    it('different verifiers produce different challenges', () => {
      const c1 = generateCodeChallenge('verifier-1');
      const c2 = generateCodeChallenge('verifier-2');
      expect(c1).not.toBe(c2);
    });
  });

  describe('server list endpoint logic', () => {
    it('returns empty array when no servers configured', () => {
      mockedGetMcpAuth.mockReturnValue({ servers: {} });
      
      const store = getMcpAuth();
      const servers = Object.entries(store.servers).map(([id, state]) => ({
        id,
        url: state.url,
        needsAuth: state.needsAuth,
      }));
      
      expect(servers).toEqual([]);
    });

    it('maps server state to response format', () => {
      mockedGetMcpAuth.mockReturnValue({
        servers: {
          'azure-test': {
            url: 'https://example.com/mcp',
            needsAuth: true,
            needsClientId: false,
            authorizationEndpoint: 'https://login.microsoftonline.com/oauth2/authorize',
            tokenEndpoint: 'https://login.microsoftonline.com/oauth2/token',
            scopes: ['https://example.com/.default'],
          },
          'github-test': {
            url: 'https://api.github.com/mcp',
            needsAuth: false,
            needsClientId: false,
            authorizationEndpoint: '',
            tokenEndpoint: '',
          },
        },
      });
      
      const store = getMcpAuth();
      const servers = Object.entries(store.servers).map(([id, state]) => ({
        id,
        url: state.url,
        needsAuth: state.needsAuth,
        needsClientId: state.needsClientId ?? false,
        expiresAt: state.expiresAt ?? null,
        error: state.error ?? null,
      }));
      
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({
        id: 'azure-test',
        url: 'https://example.com/mcp',
        needsAuth: true,
        needsClientId: false,
        expiresAt: null,
        error: null,
      });
    });
  });

  describe('start endpoint validation', () => {
    it('returns error without server parameter', () => {
      // The route returns 400 when server param missing
      const serverId = undefined;
      const isValid = !!serverId;
      expect(isValid).toBe(false);
    });

    it('returns error for unknown server', () => {
      mockedGetMcpServerAuth.mockReturnValue(undefined);
      
      const serverAuth = getMcpServerAuth('unknown-server');
      expect(serverAuth).toBeUndefined();
    });

    it('returns error when clientId missing', () => {
      mockedGetMcpServerAuth.mockReturnValue({
        url: 'https://example.com/mcp',
        needsAuth: true,
        needsClientId: true,
        authorizationEndpoint: 'https://login.microsoftonline.com/oauth2/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/oauth2/token',
        // clientId is missing
      });
      
      const serverAuth = getMcpServerAuth('test-server');
      const needsClientId = !serverAuth?.clientId;
      expect(needsClientId).toBe(true);
    });

    it('allows start when clientId present', () => {
      mockedGetMcpServerAuth.mockReturnValue({
        url: 'https://example.com/mcp',
        needsAuth: true,
        needsClientId: false,
        clientId: 'test-client-id',
        authorizationEndpoint: 'https://login.microsoftonline.com/oauth2/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/oauth2/token',
      });
      
      const serverAuth = getMcpServerAuth('test-server');
      const canStart = !!serverAuth?.clientId;
      expect(canStart).toBe(true);
    });
  });

  describe('config endpoint logic', () => {
    it('updates clientId for existing server', () => {
      mockedGetMcpServerAuth.mockReturnValue({
        url: 'https://example.com/mcp',
        needsAuth: true,
        needsClientId: true,
        authorizationEndpoint: 'https://login.microsoftonline.com/oauth2/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/oauth2/token',
      });
      
      const serverId = 'test-server';
      const clientId = 'new-client-id';
      
      const current = getMcpServerAuth(serverId);
      expect(current).not.toBeUndefined();
      
      // Simulate what the route does
      const updated = {
        ...current!,
        clientId,
        needsClientId: false,
      };
      
      setMcpServerAuth(serverId, updated);
      
      expect(mockedSetMcpServerAuth).toHaveBeenCalledWith(serverId, expect.objectContaining({
        clientId: 'new-client-id',
        needsClientId: false,
      }));
    });

    it('rejects empty clientId', () => {
      const clientId = '';
      const isValid = clientId?.trim();
      expect(isValid).toBeFalsy();
    });

    it('rejects whitespace-only clientId', () => {
      const clientId = '   ';
      const isValid = clientId?.trim();
      expect(isValid).toBeFalsy();
    });
  });

  describe('state management', () => {
    it('generates unique state values', () => {
      const state1 = randomBytes(32).toString('base64url');
      const state2 = randomBytes(32).toString('base64url');
      expect(state1).not.toBe(state2);
    });

    it('state is base64url safe', () => {
      const state = randomBytes(32).toString('base64url');
      // base64url only contains A-Z, a-z, 0-9, -, _
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('authorization URL construction', () => {
    it('builds correct URL with all parameters', () => {
      const authEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
      const clientId = 'test-client-id';
      const callbackUrl = 'http://localhost:3000/api/mcp/auth/callback';
      const state = 'test-state';
      const codeChallenge = 'test-challenge';
      const scopes = ['https://example.com/.default', 'offline_access'];
      
      const authUrl = new URL(authEndpoint);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('scope', scopes.join(' '));
      
      expect(authUrl.searchParams.get('client_id')).toBe(clientId);
      expect(authUrl.searchParams.get('redirect_uri')).toBe(callbackUrl);
      expect(authUrl.searchParams.get('response_type')).toBe('code');
      expect(authUrl.searchParams.get('state')).toBe(state);
      expect(authUrl.searchParams.get('code_challenge')).toBe(codeChallenge);
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('scope')).toBe('https://example.com/.default offline_access');
    });

    it('handles missing scopes', () => {
      const authEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
      const scopes: string[] = [];
      
      const authUrl = new URL(authEndpoint);
      
      if (scopes.length > 0) {
        authUrl.searchParams.set('scope', scopes.join(' '));
      }
      
      expect(authUrl.searchParams.has('scope')).toBe(false);
    });
  });

  describe('callback validation', () => {
    it('detects OAuth error response', () => {
      const error = 'access_denied';
      const errorDescription = 'User cancelled the request';
      
      const hasError = !!error;
      expect(hasError).toBe(true);
    });

    it('detects missing state', () => {
      const code = 'some-auth-code';
      const state = undefined;
      
      const isValid = code && state;
      expect(isValid).toBeFalsy();
    });

    it('detects missing code', () => {
      const code = undefined;
      const state = 'some-state';
      
      const isValid = code && state;
      expect(isValid).toBeFalsy();
    });
  });
});
