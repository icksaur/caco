import { describe, it, expect } from 'vitest';
import { stripStreamingActionBlock } from '../../public/ts/streaming-markdown.js';

describe('stripStreamingActionBlock (streaming flicker guard)', () => {
  it('leaves ordinary content untouched', () => {
    expect(stripStreamingActionBlock('Hello world')).toBe('Hello world');
    expect(stripStreamingActionBlock('text\n```ts\nconst x = 1;\n```')).toBe('text\n```ts\nconst x = 1;\n```');
  });

  it('strips an UNCLOSED action fence (block still streaming)', () => {
    expect(stripStreamingActionBlock('Done.\n```caco-actions\nFix it\nTest it')).toBe('Done.');
  });

  it('strips an unclosed fence with no options yet', () => {
    expect(stripStreamingActionBlock('Done.\n```caco-actions\n')).toBe('Done.');
    expect(stripStreamingActionBlock('Done.\n```caco-actions')).toBe('Done.');
  });

  it('strips a PARTIALLY-typed fence line as the final line', () => {
    expect(stripStreamingActionBlock('Done.\n```caco-act')).toBe('Done.');
    expect(stripStreamingActionBlock('Done.\n```caco')).toBe('Done.');
  });

  it('does NOT strip a short partial that could be another language', () => {
    // "```cs" (< 4 info chars) — leave it; worst case a sub-200ms flash that
    // resolves on the next delta. Avoids hiding ```css / ```cpp openings.
    expect(stripStreamingActionBlock('Done.\n```cs')).toBe('Done.\n```cs');
  });

  it('leaves a CLOSED action block alone (the code() renderer hides it)', () => {
    const closed = 'Done.\n```caco-actions\nFix it\n```';
    expect(stripStreamingActionBlock(closed)).toBe(closed);
  });

  it('strips only the trailing unclosed block when a closed one precedes it', () => {
    const raw = 'Example:\n```caco-actions\nquoted\n```\nNow:\n```caco-actions\nreal';
    expect(stripStreamingActionBlock(raw)).toBe('Example:\n```caco-actions\nquoted\n```\nNow:');
  });
});
