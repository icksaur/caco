/**
 * Tests for provider-registry.ts — BYOK config loading, namespacing, resolution,
 * and graceful degradation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockFs = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('fs', () => mockFs);

import { hasProviders, listByokModels, resolveModel, reloadProviders } from '../../src/provider-registry.js';

function setConfig(obj: unknown): void {
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue(JSON.stringify(obj));
  reloadProviders();
}

function setNoFile(): void {
  mockFs.existsSync.mockReturnValue(false);
  reloadProviders();
}

const SAMPLE = {
  providers: {
    openrouter: {
      type: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'TEST_OR_KEY',
      models: [
        { id: 'anthropic/claude-opus-4', name: 'Opus 4', agentModel: 'claude-sonnet-4.6',
          contextWindow: 200000, inputPerMtok: 5, outputPerMtok: 25, cachePerMtok: 0.5 },
      ],
    },
    ollama: {
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen2.5-coder:32b', name: 'Qwen', contextWindow: 32768 }],
    },
  },
};

describe('provider-registry', () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    delete process.env.TEST_OR_KEY;
  });
  afterEach(() => {
    reloadProviders();
  });

  describe('graceful degradation', () => {
    it('reports no providers when the file is absent', () => {
      setNoFile();
      expect(hasProviders()).toBe(false);
      expect(listByokModels()).toEqual([]);
    });

    it('treats a bare model id as GitHub (no provider) with no config', () => {
      setNoFile();
      const r = resolveModel('claude-sonnet-4.6');
      expect(r).toEqual({ cacoId: 'claude-sonnet-4.6', sdkModel: 'claude-sonnet-4.6' });
      expect(r.provider).toBeUndefined();
    });

    it('degrades to no-providers on malformed JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ not json');
      reloadProviders();
      expect(hasProviders()).toBe(false);
    });

    it('skips a provider with an id containing a colon', () => {
      setConfig({ providers: { 'bad:id': { baseUrl: 'http://x', models: [] }, good: { baseUrl: 'http://y', models: [] } } });
      expect(hasProviders()).toBe(true);
      // resolveModel on the bad provider falls back to GitHub passthrough
      const r = resolveModel('bad:id:whatever');
      expect(r.provider).toBeUndefined();
    });

    it('skips a provider missing baseUrl', () => {
      setConfig({ providers: { broken: { models: [] } } });
      expect(hasProviders()).toBe(false);
    });
  });

  describe('listing', () => {
    it('produces namespaced ids and metadata', () => {
      setConfig(SAMPLE);
      const models = listByokModels();
      expect(models.map(m => m.id)).toEqual(['openrouter:anthropic/claude-opus-4', 'ollama:qwen2.5-coder:32b']);
      const opus = models[0];
      expect(opus.name).toBe('Opus 4');
      expect(opus.capabilities?.limits?.max_context_window_tokens).toBe(200000);
      expect(opus.billing?.tokenPrices?.inputPrice).toBe(5);
      expect(opus.billing?.tokenPrices?.batchSize).toBe(1_000_000);
    });

    it('omits billing when no cost metadata is provided', () => {
      setConfig(SAMPLE);
      const qwen = listByokModels().find(m => m.id === 'ollama:qwen2.5-coder:32b');
      expect(qwen?.billing).toBeUndefined();
    });
  });

  describe('resolveModel', () => {
    it('resolves a BYOK id to sdkModel + provider with credentials from env', () => {
      process.env.TEST_OR_KEY = 'secret-key';
      setConfig(SAMPLE);
      const r = resolveModel('openrouter:anthropic/claude-opus-4');
      expect(r.providerId).toBe('openrouter');
      expect(r.sdkModel).toBe('claude-sonnet-4.6');
      expect(r.provider).toMatchObject({
        type: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'claude-sonnet-4.6',
        wireModel: 'anthropic/claude-opus-4',
        apiKey: 'secret-key',
      });
    });

    it('splits on the first colon so wireModel suffixes survive', () => {
      setConfig(SAMPLE);
      const r = resolveModel('ollama:qwen2.5-coder:32b');
      expect(r.providerId).toBe('ollama');
      expect(r.provider?.wireModel).toBe('qwen2.5-coder:32b');
    });

    it('does not require a key for local providers', () => {
      setConfig(SAMPLE);
      const r = resolveModel('ollama:qwen2.5-coder:32b');
      expect(r.provider?.apiKey).toBeUndefined();
      expect(r.provider?.bearerToken).toBeUndefined();
    });

    it('throws a clear error when the named env var is missing', () => {
      setConfig(SAMPLE);
      expect(() => resolveModel('openrouter:anthropic/claude-opus-4'))
        .toThrowError(/TEST_OR_KEY.*not set/);
    });

    it('falls back to DEFAULT_AGENT_MODEL when no agentModel is set', () => {
      setConfig(SAMPLE);
      const r = resolveModel('ollama:qwen2.5-coder:32b');
      expect(r.sdkModel).toBe('claude-sonnet-4.6');
    });

    it('treats an unknown provider prefix as a GitHub passthrough', () => {
      setConfig(SAMPLE);
      const r = resolveModel('unknownprov:some-model');
      expect(r.provider).toBeUndefined();
      expect(r.sdkModel).toBe('unknownprov:some-model');
    });
  });
});
