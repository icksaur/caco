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
