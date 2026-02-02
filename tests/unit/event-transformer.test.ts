/**
 * Event Transformer Tests
 * 
 * Tests event passthrough and shouldEmitReload detection.
 * 
 * Note: caco.embed events are now emitted directly by the embed_media tool handler,
 * not derived from SDK events in the transformer.
 */

import { describe, it, expect } from 'vitest';
import { transformForClient, shouldEmitReload } from '../../src/event-transformer.js';

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

describe('transformForClient', () => {
  it('passes through events unchanged', () => {
    const event: TestEvent = { type: 'assistant.message', data: { content: 'hello' } };
    const results = [...transformForClient(event)];
    
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(event);
  });

  it('passes through session.idle unchanged', () => {
    const event: TestEvent = { type: 'session.idle' };
    const results = [...transformForClient(event)];
    
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(event);
  });

  it('passes through tool.execution_complete unchanged', () => {
    const event: TestEvent = {
      type: 'tool.execution_complete',
      toolCallId: 'toolu_123',
      success: true,
      result: { content: 'done' }
    };
    const results = [...transformForClient(event)];
    
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(event);
  });
});

describe('shouldEmitReload', () => {
  it('returns true for tool.execution_complete with reloadTriggered', () => {
    const event: TestEvent = {
      type: 'tool.execution_complete',
      toolName: 'some_tool',
      result: {
        content: JSON.stringify({
          textResultForLlm: 'Done',
          toolTelemetry: { reloadTriggered: true }
        })
      }
    };
    
    expect(shouldEmitReload(event)).toBe(true);
  });

  it('returns false for tool.execution_complete without reloadTriggered', () => {
    const event: TestEvent = {
      type: 'tool.execution_complete',
      toolName: 'some_tool',
      result: { content: JSON.stringify({ data: 'value' }) }
    };
    
    expect(shouldEmitReload(event)).toBe(false);
  });

  it('returns false for non-tool events', () => {
    const event: TestEvent = { type: 'assistant.message', data: { content: 'hello' } };
    expect(shouldEmitReload(event)).toBe(false);
  });

  it('returns false for session.idle', () => {
    const event: TestEvent = { type: 'session.idle' };
    expect(shouldEmitReload(event)).toBe(false);
  });
});
