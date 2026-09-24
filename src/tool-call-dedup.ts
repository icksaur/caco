/**
 * Makes every Caco tool handler idempotent per tool call.
 *
 * WHY: the runtime emits `external_tool.requested` twice for one sub-agent tool
 * call (same requestId and toolCallId, on two separate event chains), and the
 * SDK client's `_handleBroadcastEvent` runs the handler once per such event with
 * no dedup. Unwrapped, every workflow, build, and file append a sub-agent issues
 * executes twice, concurrently. Root-agent calls are delivered once and are
 * unaffected. `tests/unit/tool-call-dedup.test.ts` pins that upstream fact, so a
 * future SDK that dedups on its own is noticed rather than wrapped on faith.
 *
 * A duplicate is handed the first execution's promise, so it resolves to the
 * same result or rejection and the runtime's pending call is answered exactly as
 * before. Do NOT narrow this to in-flight calls only: a fast tool can settle
 * before its duplicate is dispatched, and would then run again.
 */
import type { ToolInvocation } from '@github/copilot-sdk';

/**
 * Entries kept before the oldest is evicted. Duplicates arrive milliseconds
 * apart, so the bound only needs to outlast a burst of concurrent calls; it
 * exists to keep a long-lived server's memory flat, not to widen the window.
 */
export const TOOL_CALL_MEMO_CAPACITY = 1000;

// Process-wide rather than per tool set: create() and resume() each build a
// fresh set, and a duplicate that lands on the second must see the first's run.
const memo = new Map<string, Promise<unknown>>();

function remember(key: string, execution: Promise<unknown>): void {
  memo.set(key, execution);
  if (memo.size > TOOL_CALL_MEMO_CAPACITY) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
}

type ToolHandler = (args: unknown, invocation: ToolInvocation) => unknown;

function dedupeHandler(handler: ToolHandler): ToolHandler {
  return (args, invocation) => {
    // With no call identity there is nothing to tell a duplicate apart by, so
    // run it; suppressing here could drop a genuine call.
    if (!invocation?.toolCallId) return handler(args, invocation);

    const key = `${invocation.sessionId}\u0000${invocation.toolCallId}`;
    const prior = memo.get(key);
    if (prior) return prior;

    // Start synchronously, exactly as the unwrapped handler would; a synchronous
    // throw becomes the shared rejection so a duplicate observes it too.
    let execution: Promise<unknown>;
    try {
      execution = Promise.resolve(handler(args, invocation));
    } catch (error) {
      execution = Promise.reject(error);
    }
    remember(key, execution);
    return execution;
  };
}

/**
 * Wrap each tool's handler; every other field passes through untouched. Generic
 * over the element type because the tool factory is typed `unknown[]`: the
 * caller gets back exactly the type it passed in.
 */
export function dedupeToolCalls<T>(tools: T[]): T[] {
  return tools.map(tool => {
    const handler = (tool as { handler?: unknown }).handler;
    return typeof handler === 'function'
      ? { ...tool, handler: dedupeHandler(handler as ToolHandler) }
      : tool;
  });
}

export function _resetToolCallMemoForTests(): void {
  memo.clear();
}
