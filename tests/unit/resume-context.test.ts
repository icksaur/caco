/**
 * Tests for prompts.ts - buildResumeContext
 */
import { describe, it, expect } from 'vitest';
import { buildResumeContext } from '../../src/prompts.js';

describe('buildResumeContext', () => {
  it('includes session resumed header', () => {
    const result = buildResumeContext({ cwd: '/test/path' });
    expect(result).toContain('[SESSION RESUMED]');
  });

  it('includes shell reset message', () => {
    const result = buildResumeContext({ cwd: '/test/path' });
    expect(result).toContain('Your shell state has been reset');
  });

  it('includes session directory', () => {
    const result = buildResumeContext({ cwd: '/home/user/project' });
    expect(result).toContain('Session directory: /home/user/project');
  });

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
