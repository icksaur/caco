/**
 * SDK Normalizer Tests
 * 
 * Tests that SDK event normalization handles both wrapped and unwrapped formats.
 * This is critical because the SDK has inconsistent event structures.
 */

import { describe, it, expect } from 'vitest';
import { 
  extractProperty, 
  type RawSDKEvent 
} from '../../src/sdk-normalizer.js';

describe('extractProperty', () => {
  it('extracts from root level (live SDK format)', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      toolCallId: 'toolu_123',
      success: true
    };
    
    expect(extractProperty<string>(event, 'toolCallId')).toBe('toolu_123');
    expect(extractProperty<boolean>(event, 'success')).toBe(true);
  });

  it('extracts from data wrapper (history SDK format)', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'toolu_456',
        success: false
      }
    };
    
    expect(extractProperty<string>(event, 'toolCallId')).toBe('toolu_456');
    expect(extractProperty<boolean>(event, 'success')).toBe(false);
  });

  it('prefers data wrapper when both exist', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      toolCallId: 'root_id',
      data: {
        toolCallId: 'data_id'
      }
    };
    
    // Data wrapper takes precedence
    expect(extractProperty<string>(event, 'toolCallId')).toBe('data_id');
  });

  it('returns undefined for missing property', () => {
    const event: RawSDKEvent = { type: 'test' };
    
    expect(extractProperty<string>(event, 'missing')).toBeUndefined();
  });
});
