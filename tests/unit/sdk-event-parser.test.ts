/**
 * Tests for sdk-event-parser.ts
 * 
 * These tests ensure we correctly extract toolTelemetry from SDK events,
 * preventing regressions in the embed/output display flow.
 */

import { describe, it, expect } from 'vitest';
import { 
  extractToolTelemetry, 
  extractToolName,
  type ToolExecutionCompleteEvent 
} from '../../src/sdk-event-parser.js';

describe('extractToolTelemetry', () => {
  it('extracts outputId from nested JSON in result.content', () => {
    // This is the actual format the SDK sends - toolTelemetry is serialized inside result.content
    const event: ToolExecutionCompleteEvent = {
      toolCallId: 'toolu_123',
      success: true,
      result: {
        content: JSON.stringify({
          textResultForLlm: '[output:out_123_abc] Embedded YouTube content',
          toolTelemetry: {
            outputId: 'out_123_abc',
            provider: 'YouTube',
            title: 'Test Video'
          }
        }),
        detailedContent: 'same as content'
      },
      toolTelemetry: {}  // SDK puts empty object at top level
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry).toBeDefined();
    expect(telemetry?.outputId).toBe('out_123_abc');
    expect(telemetry?.provider).toBe('YouTube');
  });

  it('extracts reloadTriggered from nested JSON', () => {
    const event: ToolExecutionCompleteEvent = {
      success: true,
      result: {
        content: JSON.stringify({
          textResultForLlm: 'Page reload signal sent.',
          toolTelemetry: {
            reloadTriggered: true
          }
        })
      },
      toolTelemetry: {}
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry?.reloadTriggered).toBe(true);
  });

  it('returns undefined when result.content is not JSON', () => {
    const event: ToolExecutionCompleteEvent = {
      success: true,
      result: {
        content: 'Plain text result, not JSON'
      },
      toolTelemetry: {}
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry).toBeUndefined();
  });

  it('returns undefined when toolTelemetry is missing from parsed content', () => {
    const event: ToolExecutionCompleteEvent = {
      success: true,
      result: {
        content: JSON.stringify({
          textResultForLlm: 'Some result without telemetry'
        })
      },
      toolTelemetry: {}
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry).toBeUndefined();
  });

  it('falls back to top-level toolTelemetry if SDK changes behavior', () => {
    // If SDK starts putting telemetry at top level in the future
    const event: ToolExecutionCompleteEvent = {
      success: true,
      result: {
        content: 'Plain text'
      },
      toolTelemetry: {
        outputId: 'out_456_def'
      }
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry?.outputId).toBe('out_456_def');
  });

  it('ignores empty top-level toolTelemetry object', () => {
    const event: ToolExecutionCompleteEvent = {
      success: true,
      result: {
        content: 'Plain text'
      },
      toolTelemetry: {}  // Empty object should not be returned
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry).toBeUndefined();
  });

  it('handles missing result gracefully', () => {
    const event: ToolExecutionCompleteEvent = {
      success: false
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry).toBeUndefined();
  });

  it('handles real SDK embed_media event structure', () => {
    // Actual event captured from server.log
    const event: ToolExecutionCompleteEvent = {
      toolCallId: 'toolu_01HB6UBnmR3m6hUhRcTBhLwP',
      success: true,
      result: {
        content: '{"textResultForLlm":"[output:out_1769659224244_jg2lco] Embedded YouTube content: \\"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)\\" by Rick Astley","toolTelemetry":{"outputId":"out_1769659224244_jg2lco","provider":"YouTube","title":"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)","author":"Rick Astley"}}',
        detailedContent: '{"textResultForLlm":"[output:out_1769659224244_jg2lco] Embedded YouTube content"}'
      },
      toolTelemetry: {}
    };

    const telemetry = extractToolTelemetry(event);
    
    expect(telemetry?.outputId).toBe('out_1769659224244_jg2lco');
    expect(telemetry?.provider).toBe('YouTube');
    expect(telemetry?.author).toBe('Rick Astley');
  });
});

describe('extractToolName', () => {
  it('prefers toolName over name', () => {
    const event = { toolName: 'embed_media', name: 'generic' };
    expect(extractToolName(event)).toBe('embed_media');
  });

  it('falls back to name if toolName is missing', () => {
    const event = { name: 'custom_tool' };
    expect(extractToolName(event)).toBe('custom_tool');
  });

  it('returns "tool" as default', () => {
    const event = {};
    expect(extractToolName(event)).toBe('tool');
  });
});
