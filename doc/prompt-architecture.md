# Prompt Architecture

## Current State: Prompt Sources

Five distinct prompt injection points:

| Source | Location | When | Mechanism |
|--------|----------|------|-----------|
| System message | `src/prompts.ts` | Session creation | SDK `createSession({ systemMessage })` |
| Resume context | `src/prompts.ts` | First message after resume | Prepended to user message |
| Message source prefix | `src/prompts.ts` | Every non-user message | `[applet:slug]`, `[agent:id]`, `[scheduler:slug]` |
| Applet discovery | `src/prompts.ts` | In system message | `Available applets: ...` |
| Per-session config | `src/types.ts` | Session create/resume | `systemMessage`, `toolFactory`, `excludedTools` |

## Problems Identified

1. **Scattered logic** — Originally spread across 5 files
2. **Static vs dynamic** — System message built once at startup; applet list goes stale
3. **No composability** — Each piece hardcoded, can't add/remove/reorder
4. **Different mechanisms** — System message via SDK, resume/source via prepend

## Decision

**Option B: Single builder module** (`src/prompts.ts`). All prompt-building functions consolidated in one file. Lower risk, addresses the main issue (scattered logic). If dynamic registration is needed later, can evolve to a registry pattern.

```typescript
export function buildSystemMessage(): SystemMessage { ... }
export function buildResumeContext(sessionId: string): string { ... }
export function buildMessagePrefix(source: MessageSource, id: string): string { ... }
```

## Future Considerations

- **Dynamic system message**: Rebuild on applet changes
- **Per-session overrides**: Custom system message per session
- **copilot-instructions.md**: Auto-inject project instructions
