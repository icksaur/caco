# BYOK spec review

**Verdict: needs-revision.** The SDK/Caco source claims are mostly correct, but the spec needs implementation-level fixes before a fresh agent should build it.

## Must fix

- **Define the SDK model mapping for namespaced BYOK ids.** `SessionConfig.model` currently goes straight to SDK create (`src/session-manager.ts:420-430`); SDK provider falls back to `SessionConfig.model` as its wire model unless `provider.modelId`/`wireModel` are set (`node_modules/@github/copilot-sdk/dist/types.d.ts:1445-1457`). Passing `openrouter:anthropic/...` as the SDK model would likely be wrong. Specify: persisted Caco id vs SDK `model` vs `provider.modelId` vs `provider.wireModel` for create/resume/switch.
- **R4 must pass the new model on resume.** SDK resume accepts `model` and `provider` (`node_modules/@github/copilot-sdk/dist/client.js:729-754`), but Caco's current `resumeArgs` omit model (`src/session-manager.ts:528-537`). The R4 flow says `resumeSession(id, { provider, ... })`; it must include the resolved SDK model/wire model before metadata is updated.
- **Credential config is under-specified.** SDK supports `apiKey`, `bearerToken`, and `headers` (`node_modules/@github/copilot-sdk/dist/types.d.ts:1420-1443`), but the proposed file only has `apiKeyEnv`. Add `bearerTokenEnv` and guidance for env-backed headers if static bearer/header auth is in scope.
- **Document the `onListModels` closure/timing.** `client.rpc` only works after `start()` (`node_modules/@github/copilot-sdk/dist/client.js:156-163`); Caco currently starts the client before `_fetchModels()` calls `listModels()` (`src/session-manager.ts:216-223`, `src/session-manager.ts:344-348`). The handler must close over the started client and call `client.rpc.models.list({})`, not `client.listModels()`.

## Verified SDK claims

| Claim | Result | Evidence |
|---|---:|---|
| `provider` is on `SessionConfigBase`. | yes | `provider?: ProviderConfig` at `node_modules/@github/copilot-sdk/dist/types.d.ts:1219-1222`. |
| `provider` is sent on create and resume. | yes | Create payload includes `provider: config.provider` at `node_modules/@github/copilot-sdk/dist/client.js:620-629`; resume payload includes it at `node_modules/@github/copilot-sdk/dist/client.js:729-754`. |
| `setModel` has no provider param. | yes | SDK calls `rpc.model.switchTo({ modelId: model, ...options })` at `node_modules/@github/copilot-sdk/dist/session.js:805-807`; d.ts options are only `reasoningEffort`/`modelCapabilities` at `node_modules/@github/copilot-sdk/dist/session.d.ts:262-265`. |
| `onListModels` replaces runtime listing. | yes | Docs say `client.listModels()` calls handler “instead of querying the runtime” at `node_modules/@github/copilot-sdk/dist/types.d.ts:172-177`; implementation branches to `this.onListModels()` else `models.list` at `node_modules/@github/copilot-sdk/dist/client.js:853-862`. |
| Raw RPC `client.rpc.models.list({})` exists. | yes | `rpc` getter exposes server RPC after connection at `node_modules/@github/copilot-sdk/dist/client.js:156-163`; generated RPC maps `models.list` to `models.list` request at `node_modules/@github/copilot-sdk/dist/generated/rpc.js:11-19`; d.ts returns `ModelList` at `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:9259-9268`. |
| BYOK telemetry forced off. | yes | `node_modules/@github/copilot-sdk/dist/types.d.ts:1224-1229`. |

## Verified Caco integration claims

| Claim | Result | Evidence |
|---|---:|---|
| `cachedModels` is populated by `_fetchModels()` via `client.listModels()`. | yes | Assignment at `src/session-manager.ts:344-348`; failure clears it at `src/session-manager.ts:349-353`; getter returns it at `src/session-manager.ts:360-361`. |
| Create integration point is around line 420. | yes | `client.createSession({ model: config.model, ... })` at `src/session-manager.ts:420-430`. |
| Resume integration point is around line 528. | mostly | Args are built at `src/session-manager.ts:528-537`; actual `client.resumeSession(sessionId, resumeArgs)` call is `src/session-manager.ts:544-546`. |
| `/api/models` and `/api/models/raw` read `getModels()`. | yes | `src/routes/api.ts:38-46`. |
| Sessions/new-chat data reads `getModels()`. | yes | `/api/sessions` gets models at `src/routes/sessions.ts:103-105` and serializes them at `src/routes/sessions.ts:140-150`; frontend consumes them at `public/ts/main.ts:249-257` and `public/ts/session-panel.ts:367-370`; picker uses app state at `public/ts/model-selector.ts:33-44`. |
| Model-info applet reads raw models. | yes | Fetches `/api/models/raw` at `applets/model-info/script.js:57-63`. |
| `/session-model` can call async model change. | yes | Route calls `sessionManager.setSessionModel(sessionId, model)` at `src/routes/sessions.ts:481-489`; current implementation only calls `active.session.setModel(model)` at `src/session-manager.ts:931-938`. |

## Design notes / disagreements

- **Namespacing is sound if constrained.** Splitting on the first `:` preserves OpenRouter ids like `anthropic/model:free`, but provider ids must forbid `:`. The spec's “GitHub model ids never contain `:`” is an assumption, not an SDK guarantee; add collision handling.
- **Cross-provider switch via disconnect+resume is plausible, not fully specified.** SDK cannot switch providers through `setModel` (`node_modules/@github/copilot-sdk/dist/session.js:805-807`), so recreate/resume is the right direction. But specify disconnect semantics using Caco's existing disconnect path (`src/session-manager.ts:642-655`) and include model/provider mapping in resume.
- **`apiKeyEnv` is the right default.** It avoids persisted secrets, but note long-running Caco reads process env; changing shell env after server start may not affect sessions. Add `bearerTokenEnv`.
- **Reasoning-effort path is not addressed.** The SDK supports `reasoningEffort` during model switch (`node_modules/@github/copilot-sdk/dist/session.d.ts:262-265`), while Caco's local session interface and `setSessionModel` drop options (`src/session-manager.ts:97-104`, `src/session-manager.ts:931-938`). If BYOK UI adds reasoning options later, preserve same-provider `setModel(model, options)` and define behavior for recreate.

## Spec quality checklist

| Criterion | Rating | Notes |
|---|---:|---|
| Goal/problems | good | Clear goal/non-goals (`docs/byok-spec.md:5-9`). |
| Use cases/UX | good | New chat, `/session-model`, model-info, bad key path covered (`docs/byok-spec.md:87-92`). |
| Considerations/risks | medium | Good start (`docs/byok-spec.md:118-127`), but missing wire-model mapping, bearer tokens, env lifecycle, collision policy. |
| Code analysis | medium | Main SDK/Caco claims verify; create/resume details need the fixes above. |
| Divisible | good | R1-R4 order is sensible (`docs/byok-spec.md:129-136`). |
| Self-contained | medium | Enough context for source locations, but not enough exact model/provider data shapes for implementation. |
| Avoids transient state | yes | R1-R4 are requirements/order, not progress tracking. |
| Edge cases | medium | Covers config/model basics (`docs/byok-spec.md:138-145`); add future GitHub colon collision, provider removal on active resume, missing bearer/header env, malformed per-provider model entries. |
