/**
 * Embed History Integration Test
 * 
 * Tests that caco.embed events are correctly injected during history replay.
 * This prevents regressions in the embed feature.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolComplete, extractToolResultText, type RawSDKEvent } from '../../src/sdk-normalizer.js';
import { parseOutputMarkers } from '../../src/storage.js';
import { isFlushTrigger } from '../../src/caco-event-queue.js';

/**
 * Simulates the history replay logic from websocket.ts
 * Returns the positions where caco.embed events would be injected
 */
function simulateHistoryReplay(
  events: RawSDKEvent[],
  embedLookup: Map<string, { provider: string; title: string }>
): { eventIndex: number; outputId: string }[] {
  const injections: { eventIndex: number; outputId: string }[] = [];
  const pendingEmbeds: string[] = [];
  
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    
    // Flush before trigger events
    if (isFlushTrigger(evt.type) && pendingEmbeds.length > 0) {
      for (const outputId of pendingEmbeds) {
        injections.push({ eventIndex: i, outputId });
      }
      pendingEmbeds.length = 0;
    }
    
    // Queue embeds from tool completion
    const toolComplete = normalizeToolComplete(evt);
    if (toolComplete) {
      const content = extractToolResultText(toolComplete.resultContent);
      if (content) {
        for (const outputId of parseOutputMarkers(content)) {
          if (embedLookup.has(outputId)) {
            pendingEmbeds.push(outputId);
          }
        }
      }
    }
  }
  
  return injections;
}

describe('Embed History Integration', () => {
  it('injects embed before assistant.message (live SDK format)', () => {
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'embed this' } },
      { 
        type: 'tool.execution_complete',
        toolCallId: 'toolu_1',
        toolName: 'embed_media',
        success: true,
        result: { content: '[output:out_123] Embed done' }
      },
      { type: 'assistant.message', data: { content: 'Here is your embed' } }
    ];
    
    const embedLookup = new Map([
      ['out_123', { provider: 'YouTube', title: 'Test Video' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(1);
    expect(injections[0].eventIndex).toBe(2); // Before assistant.message (index 2)
    expect(injections[0].outputId).toBe('out_123');
  });

  it('injects embed before assistant.message (history SDK format with data wrapper)', () => {
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'embed this' } },
      { 
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'toolu_1',
          toolName: 'embed_media',
          success: true,
          result: { content: '[output:out_456] Embed done' }
        }
      },
      { type: 'assistant.message', data: { content: 'Here is your embed' } }
    ];
    
    const embedLookup = new Map([
      ['out_456', { provider: 'Vimeo', title: 'Test Video' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(1);
    expect(injections[0].eventIndex).toBe(2); // Before assistant.message
    expect(injections[0].outputId).toBe('out_456');
  });

  it('handles JSON-wrapped tool result (display tool format)', () => {
    const jsonResult = JSON.stringify({
      textResultForLlm: '[output:out_json] Embedding queued',
      toolTelemetry: { outputId: 'out_json', provider: 'YouTube' }
    });
    
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'embed' } },
      { 
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'toolu_1',
          success: true,
          result: { content: jsonResult }
        }
      },
      { type: 'assistant.message', data: { content: 'Done' } }
    ];
    
    const embedLookup = new Map([
      ['out_json', { provider: 'YouTube', title: 'Video' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(1);
    expect(injections[0].outputId).toBe('out_json');
  });

  it('handles multiple embeds in one turn', () => {
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'embed two videos' } },
      { 
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'toolu_1',
          success: true,
          result: { content: '[output:out_a] First' }
        }
      },
      { 
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'toolu_2',
          success: true,
          result: { content: '[output:out_b] Second' }
        }
      },
      { type: 'assistant.message', data: { content: 'Both embedded' } }
    ];
    
    const embedLookup = new Map([
      ['out_a', { provider: 'YouTube', title: 'Video A' }],
      ['out_b', { provider: 'Vimeo', title: 'Video B' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(2);
    // Both should be injected before assistant.message
    expect(injections[0].eventIndex).toBe(3);
    expect(injections[1].eventIndex).toBe(3);
    expect(injections[0].outputId).toBe('out_a');
    expect(injections[1].outputId).toBe('out_b');
  });

  it('handles multiple turns with embeds', () => {
    const events: RawSDKEvent[] = [
      // Turn 1
      { type: 'user.message', data: { content: 'first video' } },
      { 
        type: 'tool.execution_complete',
        data: { toolCallId: 't1', success: true, result: { content: '[output:turn1_embed]' } }
      },
      { type: 'assistant.message', data: { content: 'Turn 1 done' } },
      // Turn 2
      { type: 'user.message', data: { content: 'second video' } },
      { 
        type: 'tool.execution_complete',
        data: { toolCallId: 't2', success: true, result: { content: '[output:turn2_embed]' } }
      },
      { type: 'assistant.message', data: { content: 'Turn 2 done' } }
    ];
    
    const embedLookup = new Map([
      ['turn1_embed', { provider: 'YouTube', title: '1' }],
      ['turn2_embed', { provider: 'YouTube', title: '2' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(2);
    // First embed before first assistant.message (index 2)
    expect(injections[0].eventIndex).toBe(2);
    expect(injections[0].outputId).toBe('turn1_embed');
    // Second embed before second assistant.message (index 5)
    expect(injections[1].eventIndex).toBe(5);
    expect(injections[1].outputId).toBe('turn2_embed');
  });

  it('ignores non-embed outputs', () => {
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'run command' } },
      { 
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'toolu_1',
          success: true,
          result: { content: '[output:terminal_out] Command done' }
        }
      },
      { type: 'assistant.message', data: { content: 'Done' } }
    ];
    
    // Empty lookup = no embeds to inject
    const embedLookup = new Map<string, { provider: string; title: string }>();
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(0);
  });

  it('flushes on assistant.message_delta as well', () => {
    const events: RawSDKEvent[] = [
      { type: 'user.message', data: { content: 'embed' } },
      { 
        type: 'tool.execution_complete',
        data: { toolCallId: 't1', success: true, result: { content: '[output:out_delta]' } }
      },
      // Delta comes before final message in live stream
      { type: 'assistant.message_delta', data: { deltaContent: 'Here' } },
      { type: 'assistant.message', data: { content: 'Here is your embed' } }
    ];
    
    const embedLookup = new Map([
      ['out_delta', { provider: 'YouTube', title: 'Video' }]
    ]);
    
    const injections = simulateHistoryReplay(events, embedLookup);
    
    expect(injections).toHaveLength(1);
    // Should flush before delta (index 2), not wait for final message
    expect(injections[0].eventIndex).toBe(2);
  });
});
