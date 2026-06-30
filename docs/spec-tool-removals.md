# Spec: Tool removals (`caco_session_swarm`, `send_caco_message`, `list_models`)

Status: done

Three removals of differing confidence. Each is independent.

## Goals

Remove three tools that have better alternatives or whose function folds into a sibling:
`caco_session_swarm` (covered by `task` + `create_caco_session`), `send_caco_message`
(always inferior to `caco_session_delegate`), and `list_models` (sole consumer is
`create_caco_session`'s `model` param — embed the live list there instead).

## Design

### 1. `caco_session_swarm` — remove entirely

Already hidden in `DEFAULT_DISABLED_TOOLS`; the built-in `task` tool and
`create_caco_session` cover fan-out. Delete the capability, not just the registration.

### 2. `send_caco_message` — remove

Fire-and-forget messaging to an existing session. Per decision it is always a worse
choice than `caco_session_delegate` (which waits and returns the reply).
`create_caco_session(initialMessage)` covers "start a new autonomous session." The only
lost niche is "poke an existing session without waiting" — accepted.

- Keep the `POST /api/sessions/:id/messages` route (used by `delegate` and
  `create_caco_session`).
- `send_caco_message` lives in `src/agent-tools.ts` alongside `get_session_state`,
  `list_models`, `create_caco_session`; remove only the one tool + its export from the
  returned array.
- It is named in **live tool text**, not just prose: the `create_caco_session` /
  `send_caco_message` contrast (`src/agent-tools.ts:~196-199`), the delegate tool
  description (`src/delegate-tool.ts:28-30`), and the system-prompt "Caco Session Tools"
  line. Reword all three.

### 3. `list_models` — remove, fold model ids into `create_caco_session`

`list_models` is a thin wrapper over `GET /api/models` →
`sessionManager.getModels()` (the SDK's model list). The data has exactly one consumer:
the `model` param of `create_caco_session`. Remove `list_models`; surface a **live,
compact model-id list inside `create_caco_session`'s description**, generated from
`sessionManager.getModels()` when the tool is built. Single source of truth, one fewer
tool, ids are right where they are needed.

- Tradeoff: tool descriptions are built once per session start, so the list is as fresh
  as session creation — models change rarely, so this is acceptable. If staleness ever
  matters, `create_caco_session` can still return an "unknown model — available: …" error
  listing current ids (cheap, on-demand, no separate tool).
- Keep the `GET /api/models` route — it has non-tool consumers (the UI and the
  `model-info` applet, `applets/model-info/script.js:~59-63`). Only the agent-facing tool
  is removed.

## Acceptance

- **Swarm:** No `swarm` references in `src/` or `public/ts/`, no `adhoc.swarmProgress` producer or consumer; gate green.
- **send_caco_message:** Tool unregistered; `/messages` route intact; `caco_session_delegate` + `create_caco_session` still work; gate green.
- **list_models:** `list_models` unregistered; `create_caco_session` description lists current model ids; returns clear error on unknown model id; gate green.
- `tests/unit/tool-registry.test.ts` updated (disabled-defaults assertions no longer name swarm); gate green.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Delete `src/swarm-tool.ts`; remove import + `createSwarmTool` + `...swarmTools` in `server.ts` (~lines 23, 263, 273) | `src/swarm-tool.ts`, `src/server.ts` | gate: build |
| 2 | Remove `'caco_session_swarm'` from `DEFAULT_DISABLED_TOOLS` | `src/tool-registry.ts` | - |
| 3 | Delete `adhoc.swarmProgress` emit + frontend wiring (`public/ts/swarm-progress.ts` whole file; hookup in `public/ts/main.ts` ~lines 30, 181) | `public/ts/swarm-progress.ts`, `public/ts/main.ts` | gate: build:client |
| 4 | Update `tests/unit/tool-registry.test.ts` (disabled-defaults assertions) | `tests/unit/tool-registry.test.ts` | test passes |
| 5 | Delete `sendCacoMessage` `defineTool` block in `src/agent-tools.ts`; drop from returned tools | `src/agent-tools.ts` | gate: knip |
| 6 | Reword `create_caco_session` description, `src/delegate-tool.ts:28-30`, system-prompt "Caco Session Tools" line | `src/agent-tools.ts`, `src/delegate-tool.ts`, system prompt | - |
| 7 | Build `create_caco_session` description with `getModels()` id list; remove `list_models` tool; error on unknown model id | `src/agent-tools.ts` | hand case: unknown model → error lists ids |
| 8 | Update `model` param help ("Use list_models" → "see this tool's description") | `src/agent-tools.ts` | - |
| 9 | `npm run build` | - | green |
