import { describe, it, expect } from 'vitest';
import { computeFormState } from '../../public/ts/form-state.js';

describe('computeFormState', () => {
  it('idle + empty → hidden, no action', () => {
    const s = computeFormState(false, false);
    expect(s.buttonLabel).toBe('hidden');
    expect(s.buttonAction).toBe('none');
    expect(s.placeholder).toBe('Ask anything...');
    expect(s.optionsVisible).toBe(false);
    expect(s.optionsMuted).toBe(false);
  });

  it('idle + has text → send', () => {
    const s = computeFormState(false, true);
    expect(s.buttonLabel).toBe('send');
    expect(s.buttonAction).toBe('send');
    expect(s.optionsVisible).toBe(false);
  });

  it('busy + empty → stop (abort)', () => {
    const s = computeFormState(true, false);
    expect(s.buttonLabel).toBe('stop');
    expect(s.buttonAction).toBe('abort');
    expect(s.placeholder).toBe('Steer the agent...');
    expect(s.optionsVisible).toBe(false);
  });

  it('busy + has text → steer', () => {
    const s = computeFormState(true, true);
    expect(s.buttonLabel).toBe('steer');
    expect(s.buttonAction).toBe('steer');
    expect(s.optionsVisible).toBe(false);
  });

  describe('response options', () => {
    it('idle + empty + options → options visible', () => {
      const s = computeFormState(false, false, true);
      expect(s.optionsVisible).toBe(true);
      expect(s.optionsMuted).toBe(false);
      expect(s.buttonLabel).toBe('hidden');
    });

    it('idle + text + options → options muted, send enabled', () => {
      const s = computeFormState(false, true, true);
      expect(s.optionsVisible).toBe(false);
      expect(s.optionsMuted).toBe(true);
      expect(s.buttonLabel).toBe('send');
    });

    it('busy + options → options hidden', () => {
      const s = computeFormState(true, false, true);
      expect(s.optionsVisible).toBe(false);
      expect(s.optionsMuted).toBe(false);
      expect(s.buttonLabel).toBe('stop');
    });

    it('busy + text + options → steer, options hidden', () => {
      const s = computeFormState(true, true, true);
      expect(s.optionsVisible).toBe(false);
      expect(s.buttonLabel).toBe('steer');
    });

    it('no options → never visible or muted', () => {
      const s = computeFormState(false, false, false);
      expect(s.optionsVisible).toBe(false);
      expect(s.optionsMuted).toBe(false);
    });
  });
});
