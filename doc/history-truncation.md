# History Truncation

**Status: Proposed**

## Problem

Long sessions accumulate thousands of events. This session has 5,661 events (8.9MB). Streaming all of them on session load takes 10+ seconds while the user watches messages render one by one.

The SDK returns the full event log — we can't ask for a subset. But we can skip emitting most of them to the client.

## Data

| Measure | This session (59 turns) |
|---------|------------------------|
| Total events | 5,661 |
| After filter | 5,042 sent to client |
| Total size | 8.9 MB |
| Last 3 turns | 61 events, 40 KB |
| Last 5 turns | 128 events, 85 KB |
| Last 10 turns | 685 events, 919 KB |

The last 5 turns are 0.9% of the total. The other 99.1% scrolls past instantly.

## Design

### Approach: tail N turns on the server

In `streamHistory()` (websocket.ts), after fetching all events from the SDK, scan backward to find the Nth-to-last `user.message` event. Only emit events from that point forward. Send a synthetic `caco.truncated` event first to tell the client that earlier history was omitted.

```typescript
const MAX_HISTORY_TURNS = 10;

// Find the start of the last N turns
let turnsFound = 0;
let startIndex = 0;
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i].type === 'user.message') {
    turnsFound++;
    if (turnsFound >= MAX_HISTORY_TURNS) {
      startIndex = i;
      break;
    }
  }
}

// Emit truncation marker if we skipped events
if (startIndex > 0) {
  send(ws, { type: 'event', sessionId, event: {
    type: 'caco.truncated',
    data: { skipped: startIndex, total: events.length }
  }});
}

// Only stream from startIndex
for (let i = startIndex; i < events.length; i++) {
  // ... existing emit logic
}
```

### Why turns, not event count

A fixed event count (e.g., last 500) could cut in the middle of an assistant response, leaving orphaned tool calls or partial markdown. Breaking on `user.message` boundaries ensures each rendered turn is complete.

### Client: `caco.truncated` event

The client renders a subtle "N earlier messages not shown" indicator at the top of chat. Clicking it could load the full history (future enhancement).

```typescript
// In EVENT_INSERTERS:
'caco.truncated': (element, data) => {
  const skipped = data.skipped || 0;
  element.textContent = `${skipped} earlier events not shown`;
}
```

### Tuning

- `MAX_HISTORY_TURNS = 10` is a good default (covers recent context)
- Could be configurable via preferences
- Sessions under the limit stream everything (no truncation)

### What this does NOT do

- Does not delete old events (SDK owns the file)
- Does not affect the SDK's context window (it still sees full history)
- Does not affect live streaming (only history replay)

## Key files

| File | Change |
|------|--------|
| `src/routes/websocket.ts` | `streamHistory()` — scan for turn boundary, skip early events |
| `public/ts/dom-regions.ts` | Add `caco.truncated` to EVENT_TO_OUTER/INNER/INSERTERS |
