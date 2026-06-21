import { describe, it, expect } from 'vitest';
import { extractActionOptions, normalizeOptions, MAX_OPTION_LENGTH } from '../../src/offer-action-parse.js';

const block = (lines: string[]) => '```caco-actions\n' + lines.join('\n') + '\n```';

describe('normalizeOptions (shared validation, must match the tool)', () => {
  it('trims, drops blanks, caps to 4, truncates to 50', () => {
    expect(normalizeOptions([' a ', '', '  ', 'b'])).toEqual(['a', 'b']);
    expect(normalizeOptions(['1', '2', '3', '4', '5'])).toEqual(['1', '2', '3', '4']);
    const long = 'x'.repeat(60);
    expect(normalizeOptions([long])[0]).toHaveLength(MAX_OPTION_LENGTH);
  });
});

describe('extractActionOptions', () => {
  it('returns [] for a message with no block', () => {
    expect(extractActionOptions('Just some prose, no actions here.')).toEqual([]);
    expect(extractActionOptions('')).toEqual([]);
  });

  it('extracts a final-trailer block', () => {
    const msg = `Here is the fix.\n\n${block(['Fix the failing test', 'Add a regression test'])}`;
    expect(extractActionOptions(msg)).toEqual(['Fix the failing test', 'Add a regression test']);
  });

  it('allows trailing whitespace/newlines after the block', () => {
    const msg = `Done.\n${block(['Run the tests'])}\n\n  \n`;
    expect(extractActionOptions(msg)).toEqual(['Run the tests']);
  });

  it('does NOT match a caco-actions block quoted mid-message', () => {
    const msg = `For example you could emit:\n\n${block(['Sample option'])}\n\nbut that was just an example.`;
    expect(extractActionOptions(msg)).toEqual([]);
  });

  it('does NOT match actions emitted before more prose', () => {
    const msg = `${block(['Too early'])}\n\nSome trailing explanation that disqualifies it.`;
    expect(extractActionOptions(msg)).toEqual([]);
  });

  it('takes only the final block when an earlier quoted one exists', () => {
    const msg = `Example:\n${block(['quoted one'])}\nNow the real offer:\n${block(['real one', 'real two'])}`;
    expect(extractActionOptions(msg)).toEqual(['real one', 'real two']);
  });

  it('handles CRLF line endings', () => {
    const msg = 'Done.\r\n```caco-actions\r\nFix it\r\nTest it\r\n```';
    expect(extractActionOptions(msg)).toEqual(['Fix it', 'Test it']);
  });

  it('drops blank lines, caps to 4, truncates to 50 (same as the tool)', () => {
    const long = 'y'.repeat(70);
    const msg = block(['  a  ', '', 'b', 'c', 'd', 'e', long]);
    const out = extractActionOptions(msg);
    expect(out.slice(0, 4)).toEqual(['a', 'b', 'c', 'd']);
    expect(out).toHaveLength(4);
  });

  it('yields [] for a block with zero valid (non-blank) lines', () => {
    const msg = `text\n${block(['', '   ', ''])}`;
    expect(extractActionOptions(msg)).toEqual([]);
  });

  it('treats markdown/backticks/pipes in options as literal text', () => {
    const msg = block(['Use `view` not cat', 'Pipe a | b', '**bold** label']);
    expect(extractActionOptions(msg)).toEqual(['Use `view` not cat', 'Pipe a | b', '**bold** label']);
  });

  it('requires an exact caco-actions info string (rejects caco-actionsX)', () => {
    const msg = 'text\n```caco-actions-extra\nNope\n```';
    expect(extractActionOptions(msg)).toEqual([]);
  });

  it('requires the fence at line start (rejects indented/inline)', () => {
    const msg = 'text ```caco-actions\nNope\n```';
    expect(extractActionOptions(msg)).toEqual([]);
  });
});
