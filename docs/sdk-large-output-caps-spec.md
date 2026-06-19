# SDK large-output caps

## Goal

Pin Caco's Copilot SDK large-output policy explicitly so oversized SDK tool results are bounded by Caco's chosen threshold instead of ambient SDK/runtime defaults.

## Design

- Add a local `LargeToolOutputConfig` shape in `src/session-manager.ts` matching SDK `SessionOptions.largeOutput`.
- Add one helper for the Caco default: `{ enabled: true, maxSizeBytes: 20 * 1024 }`.
- Pass that config to both `client.createSession(...)` and `client.resumeSession(...)`.
- Do not set `outputDirectory` yet. SDK maps it to runtime `outputDir`, but Caco has not verified path lifetime or chat/file-applet UX for saved outputs.
- Keep this SDK-only. Caco custom tools still need separate LLM/UI output and budget work.

## Considerations

- `@github/copilot-sdk` documents `enabled` defaulting true and `maxSizeBytes` defaulting 50KB; bundled runtime internals currently use a 20KB fallback when no config is provided.
- Setting 20KB is deliberate: it may lower the effective cap for 20-50KB outputs, or be a runtime no-op if the runtime fallback already applies. Either outcome is acceptable because Caco wants the stricter budget.
- Runtime internals observed in `@github/copilot` replace large `textResultForLlm` with a saved-file notice plus preview and cap `sessionLog`; exact preview/log sizes are not contractual.
- The saved temp file path is SDK-owned. Caco should not promise persistence or applet links yet.
- `forceReadLargeFiles` and tools returning `skipLargeOutputProcessing` remain SDK-controlled escape hatches.
- The local Caco session config interfaces are type assertions around SDK calls; adding `largeOutput` to those interfaces is required so typoed wiring remains visible to TypeScript.

## Acceptance

- `SessionManager.create()` passes `largeOutput: { enabled: true, maxSizeBytes: 20480 }`.
- `SessionManager.resume()` passes the same config, including resume/recreate flows.
- Outputs under 20KB are unchanged; outputs above 20KB may become SDK saved-file notices instead of full model-facing text.
- Typecheck and focused unit tests pass.

## Plan

- [x] Add the local type/helper in `src/session-manager.ts`.
- [x] Thread the helper into create and resume args.
- [x] Add unit coverage that captures SDK create/resume args and proves the config is threaded into both.
- [x] Run focused tests, typecheck, lint as practical.
