import { describe, it, expect } from 'vitest';
import { computeFormState } from '../../public/ts/form-state.js';

describe('computeFormState', () => {
  it('idle + empty → hidden, no action', () => {
    const s = computeFormState(false, false);
    expect(s.buttonLabel).toBe('hidden');
    expect(s.buttonAction).toBe('none');
    expect(s.placeholder).toBe('Ask anything...');
  });

  it('idle + has text → send', () => {
    const s = computeFormState(false, true);
    expect(s.buttonLabel).toBe('send');
    expect(s.buttonAction).toBe('send');
  });

  it('busy + empty → stop (abort)', () => {
    const s = computeFormState(true, false);
    expect(s.buttonLabel).toBe('stop');
    expect(s.buttonAction).toBe('abort');
    expect(s.placeholder).toBe('Steer the agent...');
  });

  it('busy + has text → steer', () => {
    const s = computeFormState(true, true);
    expect(s.buttonLabel).toBe('steer');
    expect(s.buttonAction).toBe('steer');
  });
});
