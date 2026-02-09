/**
 * Tests for prompts.ts - buildResumeContext
 */
import { describe, it, expect } from 'vitest';
import { buildResumeContext } from '../../src/prompts.js';

describe('buildResumeContext', () => {
  it('includes environment hint when provided', () => {
    const result = buildResumeContext({ 
      cwd: '/test', 
      envHint: 'source .venv/bin/activate' 
    });
    expect(result).toContain('Environment hint: source .venv/bin/activate');
  });

  it('omits environment hint line when not provided', () => {
    const result = buildResumeContext({ cwd: '/test' });
    expect(result).not.toContain('Environment hint:');
  });

  it('ends with separator and newlines', () => {
    const result = buildResumeContext({ cwd: '/test' });
    expect(result).toMatch(/---\n\n$/);
  });

  it('builds complete message for user with env hint', () => {
    const result = buildResumeContext({ 
      cwd: '/home/carl/caco',
      envHint: 'module load gcc/7.5'
    });
    
    expect(result).toBe(`[SESSION RESUMED]
This is a resumed session. Your shell state has been reset.
Re-run any environment setup commands before proceeding.

Session directory: /home/carl/caco
Environment hint: module load gcc/7.5
---

`);
  });
});
