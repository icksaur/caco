/**
 * Caco Event Queue Tests
 * 
 * Tests the event queue for scheduling caco.* events.
 */

import { describe, it, expect } from 'vitest';
import { CacoEventQueue, isFlushTrigger } from '../../src/caco-event-queue.js';

describe('CacoEventQueue', () => {
  it('queues events', () => {
    const queue = new CacoEventQueue();
    const event = { type: 'caco.embed' as const, data: { outputId: 'test', provider: 'youtube', title: 'Test' } };
    
    queue.queue(event);
    
    expect(queue.hasPending()).toBe(true);
    expect(queue.length).toBe(1);
  });

  it('flushes and clears queue', () => {
    const queue = new CacoEventQueue();
    const event1 = { type: 'caco.embed' as const, data: { outputId: 'test1', provider: 'youtube', title: 'Test 1' } };
    const event2 = { type: 'caco.embed' as const, data: { outputId: 'test2', provider: 'vimeo', title: 'Test 2' } };
    
    queue.queue(event1);
    queue.queue(event2);
    
    const flushed = queue.flush();
    
    expect(flushed).toHaveLength(2);
    expect(flushed[0]).toBe(event1);
    expect(flushed[1]).toBe(event2);
    expect(queue.hasPending()).toBe(false);
    expect(queue.length).toBe(0);
  });

  it('returns empty array when flushing empty queue', () => {
    const queue = new CacoEventQueue();
    
    const flushed = queue.flush();
    
    expect(flushed).toHaveLength(0);
    expect(queue.hasPending()).toBe(false);
  });

  it('maintains FIFO order', () => {
    const queue = new CacoEventQueue();
    
    queue.queue({ type: 'caco.embed' as const, data: { outputId: 'first', provider: 'a', title: 'A' } });
    queue.queue({ type: 'caco.embed' as const, data: { outputId: 'second', provider: 'b', title: 'B' } });
    queue.queue({ type: 'caco.embed' as const, data: { outputId: 'third', provider: 'c', title: 'C' } });
    
    const flushed = queue.flush();
    
    expect(flushed[0].data.outputId).toBe('first');
    expect(flushed[1].data.outputId).toBe('second');
    expect(flushed[2].data.outputId).toBe('third');
  });

  it('can queue after flush', () => {
    const queue = new CacoEventQueue();
    
    queue.queue({ type: 'caco.embed' as const, data: { outputId: 'before', provider: 'a', title: 'A' } });
    queue.flush();
    
    queue.queue({ type: 'caco.embed' as const, data: { outputId: 'after', provider: 'b', title: 'B' } });
    
    expect(queue.hasPending()).toBe(true);
    const flushed = queue.flush();
    expect(flushed[0].data.outputId).toBe('after');
  });
});

describe('isFlushTrigger (unified for live and history)', () => {
  it('returns true for assistant.message_delta (response starting)', () => {
    expect(isFlushTrigger('assistant.message_delta')).toBe(true);
  });

  it('returns true for assistant.message (response complete)', () => {
    expect(isFlushTrigger('assistant.message')).toBe(true);
  });

  it('returns true for session.error', () => {
    expect(isFlushTrigger('session.error')).toBe(true);
  });

  it('returns false for session.idle (not a turn boundary)', () => {
    expect(isFlushTrigger('session.idle')).toBe(false);
  });

  it('returns false for tool events', () => {
    expect(isFlushTrigger('tool.execution_start')).toBe(false);
    expect(isFlushTrigger('tool.execution_complete')).toBe(false);
  });

  it('returns false for user.message', () => {
    expect(isFlushTrigger('user.message')).toBe(false);
  });

  it('returns false for unknown events', () => {
    expect(isFlushTrigger('unknown.event')).toBe(false);
  });
});
