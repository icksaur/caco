# VSCode Background Agent Mode Research

## Status: Complete

## Summary

VSCode's "Background" agent mode uses **Copilot CLI** (`@github/copilot` npm package), a standalone CLI tool that runs in a Git worktree. It is NOT built on the Copilot SDK that Caco uses. This has significant implications for MCP OAuth authentication.

## Key Finding

**Background agents explicitly cannot use MCP servers requiring authentication.**

From the [official docs](https://code.visualstudio.com/docs/copilot/agents/background-agents):

> **Limitations of background agents:**
> - Can currently only access local MCP servers that don't require authentication.

This is a documented limitation, not a solved problem.

## Architecture

### Agent Types in VSCode

| Agent Type | Implementation | MCP Auth? |
|------------|---------------|-----------|
| **Local** | VSCode extension (in-process) | Yes - has VS Code extension tools |
| **Background** | Copilot CLI (`@github/copilot`) | No - explicitly unsupported |
| **Cloud** | GitHub Coding Agent (GitHub Actions) | Server-side only |
| **Third-party** | Claude Code, OpenAI Codex, etc. | Varies |

### Copilot CLI vs Copilot SDK

| Aspect | Copilot CLI | Copilot SDK (used by Caco) |
|--------|-------------|---------------------------|
| Package | `@github/copilot` | `@anthropic-ai/sdk` + MCP |
| Authentication | GitHub OAuth (device flow) | API key |
| MCP Config | `~/.copilot/mcp-config.json` | Passed to `createSession()` |
| Open Source | No (closed binary) | Yes |
| Documented Auth Support | No OAuth MCP | HTTP headers supported |

The Copilot CLI is a separate product from the Copilot SDK. They share branding but different codebases.

## Copilot CLI MCP Details

### Configuration

MCP servers are configured in `~/.copilot/mcp-config.json`:
- GitHub MCP server comes pre-configured
- Additional servers added via `/mcp add` command
- Config stored globally per-user

### Limitations

From research, Copilot CLI:
1. Only supports **local** MCP servers (stdio transports)
2. Does not support HTTP/SSE MCP servers with OAuth
3. No interactive OAuth flow in CLI context

### Why No OAuth

Copilot CLI runs:
- In a terminal without browser integration
- Potentially in VS Code's isolated worktree
- Non-interactively in "Background" mode

Interactive browser OAuth flows would:
- Require launching a browser from CLI
- Callback coordination with running CLI process
- Not work at all in background/headless mode

## Implications for Caco's MCP OAuth Spec

### No Solution Path From VSCode

VSCode's solution for authenticated MCP servers is:
1. Use **Local agent** (in-process VSCode extension)
2. Extension-provided tools handle auth internally
3. Browser context available for OAuth popups

This doesn't help Caco because:
- Caco is a browser app, not a VSCode extension
- Caco uses the Copilot SDK, not Copilot CLI
- The auth problem is fundamentally different

### Confirmed: Caco's Approach is Correct

The spec in `mcp-oauth-auth.md` takes the right approach:
1. Use browser context for OAuth popups
2. Store tokens server-side
3. Inject headers when creating SDK sessions

This is what VSCode Local agents do internally - they have browser context available.

### Enterprise Azure AD Limitations Still Apply

From the spec's Limitations section - these are fundamental OAuth constraints, not implementation gaps:
- Client ID allowlisting
- Redirect URI restrictions  
- Client certificate requirements

VSCode's Local agent has the same limitations - it just uses Microsoft's registered client IDs.

## Relationship to Copilot SDK

### Not the Same

There was community confusion about this (see [github/copilot-cli#919](https://github.com/github/copilot-cli/discussions/919)), but:

- **Copilot CLI** = closed-source terminal agent with GitHub branding
- **Copilot SDK** = open-source library for building AI agents

The SDK's MCP support is more flexible - it accepts HTTP headers:

```typescript
mcpServers: {
  "my-server": {
    type: "http",
    url: "https://...",
    headers: { "Authorization": "Bearer ${TOKEN}" },
  }
}
```

This is the hook Caco would use for OAuth tokens.

## Recommendations

### No Changes to MCP OAuth Spec

The spec is on the right path. VSCode's approach confirms that:
1. Browser context is needed for OAuth flows
2. Token injection via headers is the standard pattern
3. The "pit of success" agent tool pattern is good UX

### Consider Documenting

Add to the spec:
- Reference to VSCode's limitation as validation of the complexity
- Note that even GitHub's first-party tools don't solve this for background/headless modes

### Future Consideration

If GitHub adds OAuth support to Copilot CLI, watch for:
- How they handle device flow vs browser flow
- Token storage mechanisms
- Any public APIs we could leverage

## References

- [VS Code Background Agents](https://code.visualstudio.com/docs/copilot/agents/background-agents)
- [About Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)
- [Using Copilot CLI - MCP](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli#add-an-mcp-server)
- [Copilot CLI Discussions](https://github.com/github/copilot-cli/discussions)
