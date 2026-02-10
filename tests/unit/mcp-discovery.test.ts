/**
 * Tests for MCP OAuth Discovery
 */

import { describe, it, expect } from 'vitest';
import { parseWWWAuthenticate } from '../../src/mcp-discovery.js';

describe('parseWWWAuthenticate', () => {
  it('parses standard OAuth format', () => {
    const header = 'Bearer authorization_uri="https://auth.example.com/authorize", token_uri="https://auth.example.com/token"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).not.toBeNull();
    expect(result!.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(result!.token_endpoint).toBe('https://auth.example.com/token');
  });
  
  it('parses alternate parameter names', () => {
    const header = 'Bearer authorization="https://auth.example.com/authorize", token="https://auth.example.com/token"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).not.toBeNull();
    expect(result!.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(result!.token_endpoint).toBe('https://auth.example.com/token');
  });
  
  it('extracts client_id if present', () => {
    const header = 'Bearer authorization_uri="https://auth.example.com/authorize", token_uri="https://auth.example.com/token", client_id="my-app"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).not.toBeNull();
    expect(result!.client_id).toBe('my-app');
  });
  
  it('returns null for non-Bearer auth', () => {
    const header = 'Basic realm="Example"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).toBeNull();
  });
  
  it('returns null if missing required endpoints', () => {
    const header = 'Bearer realm="Example"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).toBeNull();
  });
  
  it('is case-insensitive for Bearer prefix', () => {
    const header = 'bearer authorization_uri="https://auth.example.com/authorize", token_uri="https://auth.example.com/token"';
    const result = parseWWWAuthenticate(header);
    
    expect(result).not.toBeNull();
    expect(result!.authorization_endpoint).toBe('https://auth.example.com/authorize');
  });
});
