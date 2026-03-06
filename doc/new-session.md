# New Session Experience

**Status: Proposed**

## Current State

The new-chat view has a bare text input for CWD and a model selector grid. Problems:

1. **CWD input starts empty** — user must type the full path every time. `lastCwd` is in preferences but never pre-populates the input.
2. **No path validation** — user types a path, hits send, gets a server error if it's invalid. No feedback until submission.
3. **No autocomplete** — typing `/home/carl/r` gives no suggestions. User must know the exact path.

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
GET /api/files?path=/home/carl/repo → 200 (valid dir)
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
User types: /home/carl/r
Parent: /home/carl/
Prefix: r
Fetch: GET /api/files?path=/home/carl/
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

## Implementation Priority

1. **Pre-populate from last CWD** — trivial, immediate UX win
2. **Path validation** — debounced check, green/red border
3. **Recent directories** — quick-pick from session history
4. **Autocomplete popup** — most complex, highest value for new users

Items 1-2 are quick wins. Item 3 is medium effort. Item 4 is a full feature.
