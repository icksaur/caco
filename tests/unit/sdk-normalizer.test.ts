/**
 * SDK Normalizer Tests
 * 
 * Tests that SDK event normalization handles both wrapped and unwrapped formats.
 * This is critical because the SDK has inconsistent event structures.
 */

import { describe, it, expect } from 'vitest';
import { 
  extractProperty, 
  normalizeToolComplete, 
  extractToolResultText,
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

describe('normalizeToolComplete', () => {
  it('normalizes live SDK format', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      toolCallId: 'toolu_live',
      toolName: 'embed_media',
      success: true,
      result: { content: '[output:xxx] Done' }
    };
    
    const normalized = normalizeToolComplete(event);
    
    expect(normalized).toEqual({
      toolCallId: 'toolu_live',
      toolName: 'embed_media',
      success: true,
      resultContent: '[output:xxx] Done'
    });
  });

  it('normalizes history SDK format (data wrapper)', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'toolu_history',
        toolName: 'embed_media',
        success: true,
        result: { content: '[output:yyy] Done' }
      }
    };
    
    const normalized = normalizeToolComplete(event);
    
    expect(normalized).toEqual({
      toolCallId: 'toolu_history',
      toolName: 'embed_media',
      success: true,
      resultContent: '[output:yyy] Done'
    });
  });

  it('returns null for non-tool events', () => {
    const event: RawSDKEvent = { type: 'assistant.message', data: { content: 'hi' } };
    
    expect(normalizeToolComplete(event)).toBeNull();
  });

  it('returns null if toolCallId is missing', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      success: true
    };
    
    expect(normalizeToolComplete(event)).toBeNull();
  });

  it('defaults success to false if missing', () => {
    const event: RawSDKEvent = {
      type: 'tool.execution_complete',
      toolCallId: 'toolu_123'
    };
    
    const normalized = normalizeToolComplete(event);
    expect(normalized?.success).toBe(false);
  });
});

describe('extractToolResultText', () => {
  it('returns plain text as-is', () => {
    expect(extractToolResultText('Hello world')).toBe('Hello world');
  });

  it('extracts textResultForLlm from JSON', () => {
    const json = JSON.stringify({
      textResultForLlm: '[output:xxx] Embed done',
      toolTelemetry: { outputId: 'xxx' }
    });
    
    expect(extractToolResultText(json)).toBe('[output:xxx] Embed done');
  });

  it('returns original if JSON but no textResultForLlm', () => {
    const json = JSON.stringify({ data: 'value' });
    
    expect(extractToolResultText(json)).toBe(json);
  });

  it('returns undefined for undefined input', () => {
    expect(extractToolResultText(undefined)).toBeUndefined();
  });

  it('returns original for invalid JSON', () => {
    expect(extractToolResultText('not json {')).toBe('not json {');
  });
});
