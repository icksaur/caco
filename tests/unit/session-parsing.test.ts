import { describe, it, expect } from 'vitest';
import { parseSessionStartEvent, parseWorkspaceYaml } from '../../src/session-parsing.js';

describe('parseSessionStartEvent', () => {
  describe('valid session.start events', () => {
    it('extracts cwd from standard event', () => {
      const json = JSON.stringify({
        type: 'session.start',
        data: { context: { cwd: '/home/user/project' } }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: '/home/user/project' });
    });

    it('extracts cwd with Windows path', () => {
      const json = JSON.stringify({
        type: 'session.start',
        data: { context: { cwd: 'C:\\Users\\carl\\project' } }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: 'C:\\Users\\carl\\project' });
    });

    it('handles nested context correctly', () => {
      const json = JSON.stringify({
        type: 'session.start',
        data: { 
          context: { cwd: '/workspace' },
          otherField: 'ignored'
        }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: '/workspace' });
    });
  });

  describe('missing cwd', () => {
    it('returns null when cwd is missing', () => {
      const json = JSON.stringify({
        type: 'session.start',
        data: { context: {} }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: null });
    });

    it('returns null when context is missing', () => {
      const json = JSON.stringify({
        type: 'session.start',
        data: {}
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: null });
    });

    it('returns null when data is missing', () => {
      const json = JSON.stringify({
        type: 'session.start'
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: null });
    });
  });

  describe('wrong event type', () => {
    it('returns null for message events', () => {
      const json = JSON.stringify({
        type: 'message',
        data: { context: { cwd: '/should/be/ignored' } }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: null });
    });

    it('returns null for session.end events', () => {
      const json = JSON.stringify({
        type: 'session.end',
        data: { context: { cwd: '/ignored' } }
      });
      expect(parseSessionStartEvent(json)).toEqual({ cwd: null });
    });
  });

  describe('invalid input', () => {
    it('returns null for undefined', () => {
      expect(parseSessionStartEvent(undefined)).toEqual({ cwd: null });
    });

    it('returns null for empty string', () => {
      expect(parseSessionStartEvent('')).toEqual({ cwd: null });
    });

    it('returns null for whitespace only', () => {
      expect(parseSessionStartEvent('   ')).toEqual({ cwd: null });
    });

    it('returns null for invalid JSON', () => {
      expect(parseSessionStartEvent('not json')).toEqual({ cwd: null });
    });

    it('returns null for truncated JSON', () => {
      expect(parseSessionStartEvent('{"type":"session.start"')).toEqual({ cwd: null });
    });
  });
});

describe('parseWorkspaceYaml', () => {
  describe('extracts summary field', () => {
    it('returns summary from valid yaml', () => {
      expect(parseWorkspaceYaml('summary: Fix the bug')).toEqual({ summary: 'Fix the bug' });
    });
  });

  describe('null handling', () => {
    it('returns null when summary key is missing', () => {
      expect(parseWorkspaceYaml('model: gpt-4')).toEqual({ summary: null });
    });

    it('returns null for empty summary value', () => {
      expect(parseWorkspaceYaml('summary:')).toEqual({ summary: null });
    });

    it('returns null for undefined', () => {
      expect(parseWorkspaceYaml(undefined)).toEqual({ summary: null });
    });

    it('returns null for empty string', () => {
      expect(parseWorkspaceYaml('')).toEqual({ summary: null });
    });

    it('returns null for whitespace only', () => {
      expect(parseWorkspaceYaml('   ')).toEqual({ summary: null });
    });

    it('returns null for invalid yaml', () => {
      expect(parseWorkspaceYaml(':::invalid:::')).toEqual({ summary: null });
    });
  });
});
