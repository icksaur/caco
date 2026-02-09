# MCP Wrapper for Applets

**Goal:** Enable applets to call MCP tools directly, reusing the same tools agents use.

**Status:** Implemented

## Implementation Summary

Instead of wrapping the full MCP protocol, we implemented a **simplified HTTP API** that provides direct file operations:

- **HTTP Endpoints:** `/api/mcp/read_file`, `/api/mcp/write_file`, `/api/mcp/list_directory`
- **Security:** Path whitelist (workspace, ~/.caco, /tmp)
- **Client API:** `callMCPTool(toolName, params)` exposed to applet JavaScript
- **Documentation:** Added to `applet_howto` in applet-tools.ts

**Example usage in applet:**
```javascript
const result = await callMCPTool('read_file', { path: '/path/to/file.txt' });
console.log(result.content);
```

## Security Considerations

### Permission System

MCP tools can be dangerous (file writes, shell commands). Current mitigations:

1. **Path whitelist** — Only workspace, ~/.caco, and /tmp paths allowed
2. **Tool scoping** — Only `read_file`, `write_file`, `list_directory` exposed (not shell)
3. **Sandboxing** — File access limited to specific directories
