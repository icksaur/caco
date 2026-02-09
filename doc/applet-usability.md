# Applet Usability for Agents

## Problem

Agents don't reliably use applets because:
1. **Discovery gap**: System prompt lists slugs but lacks param schemas
2. **Copilot CLI sessions**: No system prompt injection — agents start with zero applet knowledge
3. **Tool naming**: `applet_howto` is about *creating* applets, not *using* them

## Solution

### `caco_applet_usage` Tool

Returns agent-oriented usage examples with URL patterns for all applets. Agents call this to discover how to show content to users.

**Output format:**
```
## text-editor
Show or edit a text file.
Link: [View file](/?applet=text-editor&path=/absolute/path/to/file.txt)
Required: path (absolute file path)
```

### `agentUsage` in meta.json

Each applet's `meta.json` includes agent-oriented metadata:

```json
{
  "agentUsage": {
    "purpose": "Show or edit a text file",
    "example": "[View file](/?applet=text-editor&path=/path/to/file.txt)",
    "triggers": ["show file", "edit file", "view source"]
  }
}
```

### `stateSchema` in meta.json

Documents what `get_applet_state` / `set_applet_state` return and accept:

```json
{
  "stateSchema": {
    "get": {
      "path": "string - current file path",
      "content": "string - file contents",
      "modified": "boolean - has unsaved changes"
    },
    "set": {
      "content": "string - update file content"
    }
  }
}
```

### Tool Naming

- `caco_applet_usage` — discover and use existing applets
- `caco_applet_howto` — documentation for *creating* new applets

### System Prompt

```
## Applets
Interactive panels for users. Provide markdown links.
Call `caco_applet_usage` to get URL patterns and examples.
```

### Repository Structure

Built-in applets live in `caco/applets/`, symlinked from `~/.caco/applets`. Version-controlled, PRs can modify them. Users can add custom applets alongside built-ins.
