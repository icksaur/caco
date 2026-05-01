# Graph Webhooks vs Polling for Caco

> Why polling beats webhooks for a localhost-first architecture.

## Graph Change Notifications (Webhooks)

Microsoft Graph supports push notifications via [change notifications](https://learn.microsoft.com/en-us/graph/webhooks). You create a subscription and Graph POSTs to your endpoint when data changes.

```
POST https://graph.microsoft.com/v1.0/subscriptions
{
  "changeType": "created",
  "notificationUrl": "https://your-server.com/webhook",
  "resource": "me/mailFolders('Inbox')/messages",
  "expirationDateTime": "2026-05-04T11:00:00Z"
}
```

### Requirements

- **Same app registration** — same appId, same delegated permissions as polling
- **Publicly reachable HTTPS endpoint** — Graph must POST to it
- **Validation handshake** — Graph sends a validation token on subscription creation; your endpoint must echo it back
- **Subscription renewal** — Mail subscriptions expire after max 3 days. Teams chat subscriptions: 1 hour (!) to 3 days depending on resource. Must renew programmatically.
- **Encryption** — Notifications can include encrypted resource data; you provide a certificate for decryption

### Subscription Lifetimes

| Resource | Max Expiration |
|----------|---------------|
| Mail messages | 3 days |
| Teams chat messages | 60 minutes |
| Teams channel messages | 60 minutes |
| Calendar events | 3 days |
| Contacts | 3 days |

Teams chat/channel subscriptions expire every **60 minutes**. You'd need a renewal loop running constantly.

## Why Webhooks Don't Fit Caco

### 1. No public endpoint

Caco runs on `localhost:53000`. Graph can't POST to localhost. Options:

- **Devtunnel** — exposes localhost, but must run permanently. Tunnel URLs change unless you use a named persistent tunnel. Authentication concerns if exposed.
- **Azure Function / server relay** — defeats the purpose of local-only architecture. Now you have a cloud component to maintain.
- **ngrok / similar** — same as devtunnel, plus third-party dependency.

### 2. Subscription churn

Teams subscriptions expire every 60 minutes. You'd need a background process renewing subscriptions continuously. If Caco restarts, subscriptions are lost and must be recreated. If the tunnel goes down, Graph deletes the subscription after failed deliveries.

### 3. Always-on requirement

Webhooks require the receiving endpoint to be up when notifications arrive. Caco is a developer tool — it may be restarted, sleeping, or the laptop may be closed. Missed notifications are gone.

### 4. Complexity

Webhook endpoint needs: validation handshake, signature verification, notification parsing, subscription lifecycle management, retry handling, encrypted content decryption. All for marginal latency improvement over polling.

## Polling: The Right Fit

Caco already has **scheduled sessions** — cron-based jobs that run agents on a schedule. Polling Graph on a schedule is natural:

### Architecture

```
Scheduled Session (cron: every 15 min)
  → Agent calls graph-mcp tools
    → GET /me/messages?$filter=receivedDateTime ge {lastCheck}
    → GET /me/chats?$filter=lastMessagePreview/createdDateTime ge {lastCheck}
  → Agent triages new items
    → Creates workflow activities
    → Updates session notes
    → Sends notifications to user
```

### Benefits

- **No public endpoint** — MCP server calls out to Graph, nothing calls in
- **No subscription management** — just a query with a time filter
- **Restart-safe** — last poll timestamp persisted on disk, picks up where it left off
- **Adjustable frequency** — 5 min for busy periods, 30 min for quiet hours
- **Works offline** — next poll catches up on everything missed
- **Already built** — Caco schedule infrastructure exists

### Polling Patterns

**Email — delta query** (most efficient):
```
GET /me/mailFolders('Inbox')/messages/delta
```
Returns changes since last sync. Graph maintains server-side state via `deltaLink`. First call returns all messages; subsequent calls return only new/changed/deleted.

**Teams — filter by time** (delta not supported for chat messages):
```
GET /me/chats/{chatId}/messages?$filter=createdDateTime ge 2026-05-01T10:00:00Z&$top=50
```

**Calendar — calendarView**:
```
GET /me/calendarView?startDateTime=2026-05-01T00:00:00Z&endDateTime=2026-05-02T00:00:00Z
```

### State Tracking

```json
// ~/.caco/graph-poll-state.json
{
  "mail": {
    "deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders('Inbox')/messages/delta?$deltatoken=abc123",
    "lastPoll": "2026-05-01T10:45:00Z"
  },
  "teams": {
    "lastPoll": "2026-05-01T10:45:00Z",
    "chatIds": ["chat-id-1", "chat-id-2"]
  }
}
```

### Sample Schedule Definition

```json
{
  "prompt": "Check for new email and Teams messages since last poll. Triage into workflow activities. Summarize anything urgent.",
  "schedule": {
    "type": "cron",
    "expression": "*/15 * * * *"
  },
  "sessionConfig": {
    "model": "gpt-4.1",
    "persistSession": false
  }
}
```

Uses a cheap model (gpt-4.1) for routine triage. Escalates to the user's active session if something needs attention.

## Hybrid: Webhook for Email, Poll for Teams

If a persistent devtunnel is already running (for portal), email webhooks become viable:

- Email subscription lasts 3 days (manageable renewal)
- Devtunnel provides the HTTPS endpoint
- Caco handles the webhook endpoint in Express
- Teams still polled (60-minute subscription is too short)

This is a future optimization, not the starting architecture.

## Summary

| Approach | Endpoint Required | Subscription Mgmt | Offline Resilience | Complexity |
|----------|-------------------|-------------------|-------------------|------------|
| Webhooks | Public HTTPS | Continuous renewal | Lost notifications | High |
| Polling | None | None | Catches up on next poll | Low |
| Hybrid | Public HTTPS (email only) | Email renewal only | Partial | Medium |

**Start with polling.** It fits Caco's architecture, uses existing schedule infrastructure, and handles all the target scenarios. Webhooks are a future optimization if latency matters.
