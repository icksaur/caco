# Documentation Index

See [doc-guidelines.md](doc-guidelines.md) for documentation standards.

## Development
- [code-quality.md](code-quality.md) - Code quality principles and review guidelines
- [testing.md](testing.md) - Unit testing patterns and coverage

## User Experience
- [session-ux.md](session-ux.md) - Session list, management, and scheduling UI
- [chat-ux.md](chat-ux.md) - Messages, streaming, markdown, and input
- [applet-ux.md](applet-ux.md) - Applet panel, expand, visibility, and controls
- [keyboard.md](keyboard.md) - Global keyboard shortcuts and scoped input
- [thinking-feedback.md](thinking-feedback.md) - Visual feedback during agent processing

## API Reference
- [API.md](API.md) - Complete HTTP API reference
- [websocket.md](websocket.md) - WebSocket protocol specification
- [shell-api.md](shell-api.md) - Shell execution endpoint
- [custom-tools.md](custom-tools.md) - Defining custom MCP tools
- [model-query.md](model-query.md) - Querying session model info

## Architecture
- [session-management.md](session-management.md) - SDK session management patterns
- [session-state-spec.md](session-state-spec.md) - Session state, observation tracking, and sync
- [session-meta-context.md](session-meta-context.md) - Preserving context across session resume
- [dom-regions.md](dom-regions.md) - DOM region ownership (prevents frontend regressions)
- [prompt-architecture.md](prompt-architecture.md) - Prompt injection points and handling
- [storage.md](storage.md) - Storage architecture for outputs and applets
- [security.md](security.md) - Security analysis and threat model
- [agent-recursion.md](agent-recursion.md) - Runaway guard for agent loops
- [agent-to-agent.md](agent-to-agent.md) - Inter-session agent communication
- [out-of-band-input.md](out-of-band-input.md) - Injecting input into busy agent sessions
- [environments.md](environments.md) - Shell/environment context on session resume

## SDK Reference
- [sdk-features.md](sdk-features.md) - Copilot SDK feature reference
- [sdk-io.md](sdk-io.md) - SDK output and feedback events
- [outputs.md](outputs.md) - Display-only tools pattern
- [skills.md](skills.md) - Skills system configuration

## Features
- [scheduler.md](scheduler.md) - Scheduled agent session design
- [vision.md](vision.md) - Vision features (screenshots, camera, images)
- [applet-vision.md](applet-vision.md) - Applet-generated images and agent visual analysis
- [applet-agent-comm.md](applet-agent-comm.md) - Applet-agent communication patterns
- [applet-usability.md](applet-usability.md) - Agent discovery and use of applets
- [embed_media.md](embed_media.md) - oEmbed tool for media embedding
- [git-applet.md](git-applet.md) - Git status/diff applet design

## Implementation Notes (working docs)
- [session-plan.md](session-plan.md) - Session manager implementation status
- [dom-modification.md](dom-modification.md) - DOM modification audit and regressions
- [caco-os.md](caco-os.md) - UI layout and navigation design
- [streaming.md](streaming.md) - Streaming implementation plan
- [unified-stream.md](unified-stream.md) - WebSocket streaming design

## Research
- [research/environments-research.md](research/environments-research.md) - Environment control research

## Archive
- [applet-archive.md](applet-archive.md) - Original applet design (superseded)
- [mcp-wrapper.md](mcp-wrapper.md) - MCP wrapper implementation summary
