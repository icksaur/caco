import { describe, expect, it } from 'vitest';
import { formatSlashPickerValue } from '../../public/ts/chat-form-popups.js';

describe('chat form popups', () => {
  it('uses custom picker values when filling slash commands', () => {
    expect(formatSlashPickerValue('agent', { id: 'reviewer', label: 'Reviewer', value: 'reviewer ' }))
      .toBe('/agent reviewer ');
  });

  it('falls back to the picker id for existing commands', () => {
    expect(formatSlashPickerValue('session-model', { id: 'gpt-5.5', label: 'GPT-5.5' }))
      .toBe('/session-model gpt-5.5');
  });
});
