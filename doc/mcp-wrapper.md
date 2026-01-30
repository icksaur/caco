# MCP Wrapper for Applets

**Goal:** Enable applets to call MCP tools directly, reusing the same tools agents use.

---

## Problem Statement

Currently:
- **Agents** can use MCP tools (`read_file`, `write_file`, GitHub tools, etc.)
- **Applets** run client-side JavaScript but cannot access MCP tools
- Agents solve problems with MCP tools, but can't write applets that reuse those solutions

**Desired flow:**
1. Agent uses `read_file` MCP tool to read code
2. Agent analyzes and solves problem  
3. Agent writes applet with `readFile()` function that calls same MCP tool
4. Applet becomes reusable code viewer using MCP infrastructure

---

## MCP Protocol Basics

### Transport Layers

MCP supports multiple transports:

| Transport | Description | Complexity |
|-----------|-------------|------------|
| **stdio** | Process spawns, communicates via stdin/stdout | Simple |
| **HTTP** | REST-like requests to server endpoint | Simple |
| **SSE** | Server-Sent Events for streaming | Complex |

**Recommendation:** Focus on stdio and HTTP. Leave SSE out of scope.

### Communication Pattern

MCP uses **JSON-RPC 2.0** over the transport:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": { "path": "/home/user/file.txt" }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "file contents here..."
      }
    ]
  }
}
```

### Tool Discovery

Before calling tools, clients discover available tools:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "tools/list"
}

// Response
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "tools": [
      {
        "name": "read_file",
        "description": "Read a file from disk",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          }
        }
      }
    ]
  }
}
```

---

## Architecture Options

### Option 1: Server-Side Proxy

Applet calls HTTP endpoint, server proxies to MCP:

```
Applet (client) → POST /api/mcp/call → Server → MCP Tool → Response
```

**Pros:**
- Simple client API
- Server controls permissions
- Works with all MCP transports

**Cons:**
- HTTP round-trip for every call
- Server must manage MCP connections

### Option 2: Client-Side MCP Client

Applet runs MCP client directly in browser:

```
Applet → WebAssembly MCP Client → WebSocket → Server → MCP Tool
```

**Pros:**
- No server proxy logic
- Direct communication

**Cons:**
- Complex client implementation
- Limited by browser capabilities (no stdio)

### Option 3: Hybrid - Server Exposes MCP as REST

Server wraps MCP tools as simple REST endpoints:

```
POST /api/tools/read_file
{ "path": "/home/user/file.txt" }

→ { "content": "..." }
```

**Pros:**
- Simplest client API
- RESTful, no JSON-RPC complexity
- Easy to document

**Cons:**
- Server must wrap each tool
- Not true MCP client (loses protocol benefits)

---

## Recommended Approach: Server-Side Proxy (Option 1)

Create generic MCP proxy endpoint that accepts any tool call.

### API Design

#### Endpoint: `POST /api/mcp/call`

Request:
```json
{
  "server": "filesystem",      // MCP server name
  "tool": "read_file",         // Tool name
  "arguments": {               // Tool arguments
    "path": "/home/user/file.txt"
  }
}
```

Response:
```json
{
  "ok": true,
  "result": {
    "content": "file contents..."
  }
}
```

Error response:
```json
{
  "ok": false,
  "error": "File not found"
}
```

#### Endpoint: `GET /api/mcp/servers`

List available MCP servers and their tools:

```json
{
  "servers": {
    "filesystem": {
      "tools": ["read_file", "write_file", "list_directory"]
    },
    "github": {
      "tools": ["create_issue", "list_repos"]
    }
  }
}
```

---

## Implementation Plan

### Phase 1: MCP Client Manager

Create server-side MCP client pool with idle timeout:

```typescript
// src/mcp-client-manager.ts
interface ClientEntry {
  client: MCPClient;
  lastUsed: number;
  timeout?: NodeJS.Timeout;
}

class MCPClientManager {
  private clients = new Map<string, ClientEntry>();
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  
  async callTool(server: string, tool: string, args: unknown): Promise<unknown> {
    const entry = await this.getOrCreateClient(server);
    
    // Reset idle timer on each use
    this.resetIdleTimer(server, entry);
    
    return await entry.client.call(tool, args);
  }
  
  private async getOrCreateClient(server: string): Promise<ClientEntry> {
    let entry = this.clients.get(server);
    if (!entry) {
      const client = await this.createClient(server);
      entry = { client, lastUsed: Date.now() };
      this.clients.set(server, entry);
    }
    return entry;
  }
  
  private resetIdleTimer(server: string, entry: ClientEntry): void {
    entry.lastUsed = Date.now();
    
    // Clear existing timeout
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    
    // Set new timeout to close after idle period
    entry.timeout = setTimeout(async () => {
      console.log(`[MCP] Closing idle client: ${server}`);
      await entry.client.shutdown();
      this.clients.delete(server);
    }, this.IDLE_TIMEOUT);
  }
  
  async shutdown(): Promise<void> {
    // Close all clients on server shutdown
    for (const [server, entry] of this.clients) {
      if (entry.timeout) clearTimeout(entry.timeout);
      await entry.client.shutdown();
    }
    this.clients.clear();
  }
}
```

**Idle timeout strategy:**
- Close stdio processes after 5 minutes of inactivity
- Reset timer on each tool call
- Clean up all clients on server shutdown
- Balance: avoid spawn overhead vs memory usage

### Phase 2: API Endpoint

Add route handler:

```typescript
// src/routes/mcp.ts
router.post('/mcp/call', async (req, res) => {
  const { server, tool, arguments: args } = req.body;
  
  try {
    const result = await mcpManager.callTool(server, tool, args);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});
```

### Phase 3: Client Helper

Add helper to applet runtime:

```typescript
// public/ts/applet-runtime.ts
async function callMCPTool(server: string, tool: string, args: unknown) {
  const response = await fetch('/api/mcp/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server, tool, arguments: args })
  });
  
  const data = await response.json();
  if (!data.ok) throw new Error(data.error);
  return data.result;
}
```

### Phase 4: Applet API

Expose to applets:

```javascript
// In applet code
const fileContent = await callMCPTool('filesystem', 'read_file', {
  path: '/home/user/code.ts'
});

document.getElementById('editor').value = fileContent.content;
```

---

## Security Considerations

### Permission System

MCP tools can be dangerous (file writes, shell commands). Need permissions:

1. **Server-level filtering**
   - Only expose safe MCP servers to applets
   - Blacklist dangerous tools (shell, delete_file)

2. **User confirmation**
   - Prompt user before destructive operations
   - "Applet wants to write to disk. Allow?"

3. **Sandboxing**
   - Limit file access to specific directories
   - Rate limiting on tool calls

### Configuration

```typescript
// server.ts
const APPLET_ALLOWED_SERVERS = ['filesystem', 'github'];
const APPLET_BLOCKED_TOOLS = ['shell_exec', 'delete_file'];
```

---

## Example Use Cases

### 1. Code Viewer Applet

Agent uses `read_file` → writes applet that uses same tool:

```javascript
// Applet code
async function loadFile(path) {
  const result = await callMCPTool('filesystem', 'read_file', { path });
  document.getElementById('code').textContent = result.content;
  hljs.highlightElement(document.getElementById('code'));
}
```

### 2. GitHub Issue Browser

Agent uses GitHub MCP tools → writes applet:

```javascript
async function listIssues(repo) {
  const result = await callMCPTool('github', 'list_issues', { 
    owner: 'user',
    repo: repo 
  });
  
  renderIssues(result.issues);
}
```

### 3. File Manager

Agent uses file tools → writes interactive file browser:

```javascript
async function browseDirectory(path) {
  const result = await callMCPTool('filesystem', 'list_directory', { path });
  
  result.files.forEach(file => {
    const item = document.createElement('div');
    item.textContent = file.name;
    item.onclick = () => file.isDirectory 
      ? browseDirectory(file.path)
      : loadFile(file.path);
    fileList.appendChild(item);
  });
}
```

---

## TypeScript Interfaces Question

> "we have a TON of TS interfaces. What are those? Like structs?"

**Yes, TypeScript interfaces are like C++/C# structs**, but:

1. **Compile-time only** - Disappear after compilation
2. **Documentation** - Provide type hints for IDE/compiler
3. **No runtime cost** - Zero overhead in JavaScript output

### When interfaces seem "dead":

```typescript
// Defined and used in one place
interface FooOptions {
  bar: string;
  baz: number;
}

function foo(options: FooOptions) {
  // ...
}
```

This is **normal in TypeScript**:
- Provides type safety for function parameters
- Better than inline types: `(options: { bar: string, baz: number })`
- Makes refactoring easier

### Dead Code Detection

We use **knip** (runs in `npm run build`):
```bash
npm run knip
```

Knip finds:
- Unused exports
- Unused types (if truly unused)
- Unused dependencies

If knip doesn't report it, the interface is being used (even if locally).

---

## Next Steps

1. Create `mcp-client-manager.ts` - Pool of MCP clients
2. Add `POST /api/mcp/call` endpoint
3. Expose `callMCPTool()` to applets
4. Write security filtering layer
5. Document available tools for agents

---

## Open Questions

1. **Which MCP servers to expose?**
   - Start with filesystem only?
   - GitHub requires auth token
   
2. **Permission granularity?**
   - Per-tool permissions?
   - Per-directory restrictions?
   
3. **Async vs sync API?**
   - All MCP calls are async
   - Applets must use `await`
   
4. **Error handling UX?**
   - Toast notifications?
   - Inline error display?
