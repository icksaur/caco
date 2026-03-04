# Applet Context Awareness

## Problem

When a user is viewing an applet and sends a message, the agent has no idea what applet they're looking at unless it proactively calls `get_applet_state`. On resumed sessions, the agent doesn't know to do this. The user has to explicitly mention "the file browser" or "the dashboard" for the agent to understand context.

Additionally, when the same applet slug is reloaded (e.g. navigating within file-browser), the server clears all applet user state because it treats every `POST /applets/:slug/load` as an applet change. This wipes context that the applet's JS set up.

## Goals

1. Agent automatically understands the user's current applet context without a tool call
2. Server tracks the active applet slug and URL params at all times
3. Same-slug applet reloads preserve user state instead of wiping it
4. System prompt tells agent to call `get_applet_state` early for richer context

## Current Architecture

### Applet Load Flow
1. Frontend calls `POST /api/applets/:slug/load`
2. Server **always clears** `appletUserState` (line 283 of api.ts)
3. Server returns HTML/JS/CSS
4. Frontend runs applet JS, which may call `setAppletState()`
5. Navigation context is only updated when a **message** is sent (via `appletNavigation` in POST body)

### State Tracking (`src/applet-state.ts`)
- `appletUserState` — key/value state pushed by applet JS (for agent to query)
- `appletNavigation` — `{ stack: [{slug, label}], urlParams }` — only set on message send
- No tracking of which applet is currently active between messages

### Agent Awareness
- System prompt mentions applets exist and lists slugs
- No instruction to check current applet context
- No resume-specific prompt

## Design

### 1. Track Active Applet on Server (`src/applet-state.ts`)

Add `activeSlug` tracking:

```typescript
let activeSlug: string | null = null;

export function getActiveAppletSlug(): string | null { return activeSlug; }
export function setActiveAppletSlug(slug: string | null): void { activeSlug = slug; }
```

### 2. Frontend Posts Slug + Params on Load (`public/ts/applet-runtime.ts`)

Update `loadAppletBySlug` to send URL params in the POST body:

```typescript
const response = await fetch(`/api/applets/${slug}/load`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ urlParams: getAppletUrlParams() })
});
```

### 3. Smart State Clearing on Load (`src/routes/api.ts`)

In `POST /applets/:slug/load`:

```typescript
const { urlParams } = req.body || {};
const currentSlug = getActiveAppletSlug();

// Only clear state if switching to a different applet
if (slug !== currentSlug) {
  clearAppletUserState();
}

// Always update active slug and navigation
setActiveAppletSlug(slug);
if (urlParams) {
  setAppletNavigation({ 
    stack: [{ slug, label: stored.meta.name }], 
    urlParams 
  });
}
```

### 4. Include Active Slug in `get_applet_state` Response (`src/applet-tools.ts`)

The tool already returns navigation context. With the server now tracking `activeSlug`, the response will always show the current applet even between messages.

Update the tool response to include `activeSlug`:

```typescript
const activeSlug = getActiveAppletSlug();
// Include in response alongside state and navigation
```

### 5. System Prompt Update (`src/prompts.ts`)

Add to the Applets section:

```
When the user sends a message, call \`get_applet_state\` if you don't already know
what they're looking at. This returns the active applet, its URL params, and any
state the applet has pushed. Understanding the user's visual context helps you
give relevant answers.
```

This goes in both the system message (new sessions) and is inherently available on resume since the system message persists.

## Implementation Plan

1. **`src/applet-state.ts`** — Add `activeSlug` tracking (get/set)
2. **`src/routes/api.ts`** — Smart clear: only wipe state on slug change, update `activeSlug` and navigation on every load
3. **`public/ts/applet-runtime.ts`** — Send `urlParams` in load POST body
4. **`src/applet-tools.ts`** — Include `activeSlug` in `get_applet_state` response
5. **`src/prompts.ts`** — Add applet context instruction to system message
6. **`npm run build:client`** — Rebuild frontend bundle

## What Does NOT Change

- `setAppletState()` / `get_applet_state` tool API — unchanged
- `set_applet_state` tool — unchanged
- Applet JS contracts — applets still call `setAppletState()` in their startup JS as before
- `clearAppletUserState()` on applet **change** — still happens, just not on same-slug reload
- Message-time `appletNavigation` — still sent, still works, now supplemented by load-time tracking

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent calls `get_applet_state` when no applet is open | Tool already handles empty state gracefully |
| Same-slug reload with stale state | Applet JS runs on each load and calls `setAppletState()` to refresh |
| System prompt bloat | Addition is 3 lines — minimal |
| Applet urlParams not available in POST body | Falls back to current behavior (navigation set on next message) |
