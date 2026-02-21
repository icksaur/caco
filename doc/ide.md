# IDE Integration (Copilot CLI v0.0.409+)

Copilot CLI can connect to a running VS Code instance, gaining access to editor state and approval workflows. This document covers the mechanism, available tools, and implications for Caco.

## Requirements

- VS Code 1.109.3+
- Copilot Chat extension v0.38+ (writes lock files)
- Copilot CLI v0.0.409+ (reads lock files)
- CLI must run from VS Code's integrated terminal (for auto-connect) or use `/ide` to pick manually

## Mechanism

VS Code's Copilot Chat extension runs an MCP server over a Unix domain socket and advertises it via lock files.

**Lock file location**: `~/.copilot/state/ide/<name>.lock`

**Lock file schema** (Zod-validated by CLI):
```
socketPath: string       # Unix socket path
scheme: string           # Protocol scheme
headers: Record<string, string>
pid: number              # VS Code process PID
timestamp: number        # When lock was written
workspaceFolders: string[]  # Open workspace paths
ideName: string          # e.g. "VS Code"
isTrusted?: boolean      # Workspace trust state
```

**Connection flow**:
1. CLI startup: scan `~/.copilot/state/ide/` for `.lock` files
2. Validate each: check PID is alive via `process.kill(pid, 0)`
3. Match: compare `workspaceFolders` against `process.cwd()`
4. Auto-connect if match found; otherwise `/ide` shows a picker dialog
5. Connect via `StreamableHTTPClientTransport` to the lock file's `socketPath`

## Tools Provided

When connected, three tools are registered on the CLI's MCP host:

- **`get_diagnostics`** — compiler/linter errors and warnings from VS Code's Problems panel
- **`get_selection`** — current editor selection and surrounding context
- **`open_diff`** — open a diff tab in VS Code for file change review; user can approve/reject visually

## Trust Sync

Folders trusted in VS Code (via Workspace Trust) are automatically trusted in the CLI. The `isTrusted` field in the lock file propagates this. The CLI's own `~/.copilot/config.json` `trusted_folders` array is separate.

## Class Hierarchy (reverse-engineered from v0.0.409 bundle)

- **`u6`** — base MCP host class. Manages MCP server lifecycle (start, stop, get tools, configure auth). Used by the SDK's `Session` class.
- **`ZY extends u6`** — CLI-only subclass. Adds IDE discovery, auto-connect, `getConnectedIdeInfo()`, `setIdeDisconnectedCallback()`, and the three IDE tools. Only instantiated by the interactive CLI, never by the SDK.

The SDK `Session.initializeMcpHost()` creates `new u6(...)`. The `getConnectedIdeInfo()` method on Session guards with `this.mcpHost instanceof ZY`, which is always false for SDK sessions.

## Caco Implications

**SDK cannot use `/ide`**. The copilot-sdk's `Session` class uses the base `u6` MCP host, not `ZY`. There is no SDK API to connect to an IDE.

**Direct socket connection is theoretically possible**. Since the lock files contain a standard Unix socket path and the transport is `StreamableHTTPClientTransport` (standard MCP HTTP over Unix socket), Caco could:

1. Watch `~/.copilot/state/ide/` for `.lock` files
2. Parse the lock file JSON
3. Validate PID is alive
4. Match `workspaceFolders` against Caco's configured working directory
5. Connect as an MCP client to `socketPath` with the provided `headers` and `scheme`
6. Call `get_diagnostics`, `get_selection`, `open_diff` directly

This would bypass the SDK entirely at the MCP transport layer. The socket is a standard MCP server — any MCP client can connect if it knows the path and headers.

**Open questions**:
- Does the socket require authentication beyond the headers in the lock file?
- Can multiple clients connect to the same socket simultaneously?
- Does the extension rate-limit or scope tool calls per connection?
- Will the lock file format remain stable across extension versions?
