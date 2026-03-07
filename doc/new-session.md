# New Session Experience

**Status: Proposed**

## Current State

The new-chat view has a bare text input for CWD and a model selector grid. Problems:

1. **CWD input starts empty** — user must type the full path every time. `lastCwd` is in preferences but never pre-populates the input.
2. **No path validation** — user types a path, hits send, gets a server error if it's invalid. No feedback until submission.
3. **No autocomplete** — typing `/home/user/r` gives no suggestions. User must know the exact path.

## Proposals

### 1. Pre-populate CWD from last session

When `showNewChat()` runs, populate `#newChatCwd` with `getCurrentCwd()` (from the last active session). This is the most common case — user wants a new chat in the same project.

```typescript
// In showNewChat() or loadModels():
const cwdInput = document.getElementById('newChatCwd');
if (cwdInput && !cwdInput.value) {
  cwdInput.value = getCurrentCwd();
}
```

### 2. Path validation with visual feedback

Debounced server check as the user types. Show a green ✓ or red ✗ next to the input.

**Server endpoint**: `GET /api/files?path=<encoded>` already exists and returns directory listings. A lightweight check:

```
GET /api/files?path=/home/user/repo → 200 (valid dir)
GET /api/files?path=/nonexistent   → 404 (invalid)
```

**Client**: debounce 500ms, fetch, toggle a CSS class:

```typescript
cwdInput.addEventListener('input', debounce(async () => {
  const cwd = cwdInput.value.trim();
  if (!cwd) { clearValidation(); return; }
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(cwd)}`);
    cwdInput.classList.toggle('valid', res.ok);
    cwdInput.classList.toggle('invalid', !res.ok);
  } catch {
    cwdInput.classList.remove('valid', 'invalid');
  }
}, 500));
```

CSS: green border for `.valid`, red border for `.invalid`.

### 3. Path autocomplete suggestions

When the user types a partial path, show directory suggestions in a popup.

**Approach A: Reuse InputPopup** — same popup used for `/` and `#` commands. On each keystroke (debounced), fetch directory listing of the parent path and filter by the typed prefix.

```
User types: /home/user/r
Parent: /home/user/
Prefix: r
Fetch: GET /api/files?path=/home/user/
Filter: entries starting with "r" that are directories
Show: [repo/, rust-projects/, ...]
```

**Approach B: HTML datalist** — native browser autocomplete. Simpler but less controllable:

```html
<input type="text" id="newChatCwd" list="cwdSuggestions">
<datalist id="cwdSuggestions"></datalist>
```

Populate the datalist on input. Browser handles the popup UI.

**Recommendation**: Approach A (InputPopup) for consistency with existing popup patterns. The popup infrastructure is already there — just need a new trigger on the CWD input.

### 4. Recent directories

Show last 5 CWDs from session history as quick-pick options below the input.

```
Recent: caco/ · mesh/ · bbl/ · discord-messages/
```

Each is clickable, populates the CWD input.

**Data source**: `GET /api/sessions` already returns `grouped` by CWD. Extract unique CWDs sorted by most recent.

## Implementation Status

- [x] **Pre-populate from last CWD** — implemented in `chat-view-controller.ts showNewChat()`
- [x] **Path validation** — implemented in `model-selector.ts setupCwdFooterSync()`, green/red border
- [ ] **Autocomplete popup** — detailed design below
- [ ] **Recent directories** — future enhancement

## Autocomplete Popup Design

### Goal

As the user types a path in `#newChatCwd`, show directory suggestions in a popup. Must be performant — no excessive network traffic.

### Strategy: Fetch on `/`, filter locally

Only fetch a directory listing when the parent directory changes. Between path separators, filter the cached listing client-side.

**Network behavior:**
```
User types: /home/user/r
  Parent changed to /home/user/ → FETCH once
  Filter cached entries by prefix "r" → client-side, instant
  Show: [repo/, rust-projects/]

User types: /home/user/re
  Same parent → NO FETCH
  Filter by "re" → [repo/]

User types: /home/user/repo/
  Parent changed to /home/user/repo/ → FETCH once
  Show all children (empty prefix)

User types: /home/user/repo/c
  Same parent → NO FETCH
  Filter by "c" → [caco/]
```

**Result:** One fetch per directory level navigated. Typing within a level = zero fetches.

### Cache

Single-entry cache — one parent directory at a time:

```typescript
let cachedParent = '';
let cachedEntries: string[] = [];
```

When parent changes: fetch `GET /api/files?path=<parent>`, filter response to directories only (`type === 'directory'`), store in cache. When parent is the same: skip fetch, use cached entries.

### Parsing the input

```typescript
function splitPath(input: string): { parent: string; prefix: string } {
  const lastSlash = input.lastIndexOf('/');
  if (lastSlash === -1) return { parent: '', prefix: input };
  return {
    parent: input.slice(0, lastSlash + 1),  // includes trailing /
    prefix: input.slice(lastSlash + 1)       // after last /
  };
}
```

### Popup lifecycle

Use `InputPopup` (same as `/` and `#`):
- **Show**: when input has a valid parent directory and there are matching entries
- **Select**: populate input with `parent + selectedEntry`, trigger input event for validation
- **Dismiss**: Escape, click outside, or input blurred
- **Hide**: when no matches or input is empty

### Trigger

Debounce 200ms on `#newChatCwd` input event. Shorter than validation (300ms) because autocomplete should feel responsive.

### Integration with existing code

The autocomplete runs alongside the existing validation + footer sync in `setupCwdFooterSync()`. The popup is created once and reused (same pattern as slash/pound popups in `multiline-input.ts`).

```typescript
// In model-selector.ts setupCwdFooterSync():
let cwdPopup: InputPopup | null = null;
let cachedParent = '';
let cachedEntries: string[] = [];
let acDebounce: ReturnType<typeof setTimeout> | null = null;

cwdInput.addEventListener('input', () => {
  // ... existing validation debounce (300ms) ...
  
  // Autocomplete debounce (200ms)
  if (acDebounce) clearTimeout(acDebounce);
  acDebounce = setTimeout(() => {
    if (getViewState() !== 'newChat') return;
    void updateCwdAutocomplete(cwdInput);
  }, 200);
});
```

### Server endpoint

`GET /api/files?path=<dir>` already returns:
```json
{
  "path": "/home/user/repo",
  "files": [
    { "name": "caco", "type": "directory", "size": 4096 },
    { "name": "mesh", "type": "directory", "size": 4096 },
    { "name": "notes.txt", "type": "file", "size": 1234 }
  ]
}
```

Filter to `type === 'directory'` on the client.

### Edge cases

| Case | Behavior |
|------|----------|
| Root `/` | Fetch `/`, show top-level dirs |
| Empty input | No popup |
| Invalid parent (404) | Clear cache, hide popup |
| `~` prefix | Expand to `$HOME` before fetching (or let server handle) |
| Windows paths `C:\` | `lastIndexOf('/')` won't work — use `lastIndexOf(/[\\/]/)` |
| Very large directories | Show max 20 entries, sorted alphabetically |

### Risks

| Risk | Mitigation |
|------|------------|
| User pastes long path → many fetches | Debounce 200ms, single-entry cache means only parent changes trigger fetch |
| `/` or `/usr` has 1000+ dirs | Limit to 20 suggestions, alphabetical |
| Network error during fetch | Silently ignore, hide popup |
| Popup conflicts with validation border | Popup sits above input, border is on the input — no conflict |

### Key files

| File | Change |
|------|--------|
| `public/ts/model-selector.ts` | Add autocomplete logic to `setupCwdFooterSync` |
| `public/ts/input-popup.ts` | No changes — reuse existing class |
