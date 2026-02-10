# Copilot SDK Features

## Client Management
- Create and manage CopilotClient instances
- Connect to local or remote CLI servers
- Configure stdio or TCP transport modes
- Auto-start and auto-restart CLI process
- Custom CLI path and arguments
- Environment variable configuration

## Session Management
- Create new sessions with custom IDs
- Resume existing sessions
- Configure working directory per session
- Session metadata tracking (start time, modified time, summary)
- Multiple concurrent sessions support

## Model Configuration
- Select AI models (gpt-4.1, etc.)
- Custom provider support (BYOK - Bring Your Own Key)
- OpenAI-compatible API endpoints
- Azure OpenAI support
- Anthropic provider support

## Messaging
- Send messages with prompts
- Attach files (single or multiple)
- Attach directories
- Message queueing (enqueue/immediate modes)
- Wait for response or fire-and-forget

## Streaming
- Enable/disable response streaming
- Receive message deltas in real-time
- Reasoning chunks streaming
- Session event handling

## Custom Tools
- Define custom tools with handlers
- Zod schema integration for type safety
- JSON schema support for parameters
- Tool result types (success, failure, rejected, denied)
- Binary results for tools (images, files)
- Tool telemetry tracking

## Built-in Tool Management
- Allow/exclude specific tools
- Tool whitelisting with availableTools
- Tool blacklisting with excludedTools
- Default tool set access

## System Message Control
- Append mode: Extend default system message
- Replace mode: Full system message override
- Custom instructions injection

## Permission Handling
- Permission request callbacks
- Shell execution permissions
- File write permissions
- File read permissions
- URL access permissions
- MCP server permissions
- Custom approval rules

## MCP (Model Context Protocol) Integration
- Local MCP server configuration
- Remote MCP server support (HTTP/SSE)
- Per-server tool selection
- Server timeout configuration
- Environment variables for MCP servers
- Custom headers for remote servers

## Custom Agents
- Define custom agent configurations
- Agent-specific tool access
- Agent-specific MCP servers
- Agent display names and descriptions
- Agent inference control

## Skills System
- Load skills from directories
- Disable specific skills
- Skill discovery and management

## Event System
- Session event listeners
- Assistant message events
- Tool call events
- Error events
- Connection state events

## Connection Management
- Connection state monitoring (disconnected, connecting, connected, error)
- Automatic reconnection handling
- Graceful shutdown

## Logging
- Configurable log levels (none, error, warning, info, debug, all)
- CLI server logging control

## MCP Diagnostics

### CLI Diagnostics (copilot-cli)
- `/mcp` command lists configured MCP servers and their status
- Shows server connection state (connected, error, disabled)
- Lists available tools per server
- **Limitation**: Not available in browser/SDK contexts

### SDK Diagnostic Capabilities
- Connection state events for monitoring server health
- Error events when MCP servers fail to connect
- No built-in API to enumerate MCP tools or server status from SDK
- Tool availability only discoverable when tool calls fail

### Browser Context Limitations
When running Caco in a browser context:
- Cannot run interactive OAuth/browser authentication flows
- MCP servers requiring Azure AD authentication cannot complete auth
- No `/mcp` diagnostic command available
- Server failures may be silent until tool invocation fails

## Authentication Challenges

### Azure AD / Interactive Auth Issues
MCP tools requiring Azure AD (AAD) authentication present challenges:
- AAD typically requires interactive browser popup for OAuth
- In headless/browser-agent contexts, popups cannot be intercepted
- Pre-authenticated tokens must be provided via environment variables or headers

### Workarounds
1. **Pre-authenticate externally**: Obtain tokens via CLI before running browser session
2. **Use environment variables**: Configure `AZURE_ACCESS_TOKEN` or similar for MCP servers
3. **Custom headers**: Remote MCP servers can receive `Authorization: Bearer <token>` headers
4. **Service principal auth**: Use client credentials flow instead of interactive auth

### Known SDK Issues
- **github/copilot-sdk#163**: MCP server environment variables not being read properly
- **github/copilot-sdk#350**: Question about using built-in tools from SDK
- **modelcontextprotocol/python-sdk#2024**: Proposes multi-protocol authentication with discovery and OAuth fallback

## Future: Multi-Protocol Authentication
The MCP ecosystem is working toward unified authentication discovery:
- Spec-aligned authentication method discovery
- OAuth fallback mechanisms
- Protocol-level auth negotiation

See: [MCP Python SDK #2024](https://github.com/modelcontextprotocol/python-sdk/issues/2024)
