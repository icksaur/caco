# Spec: Tool removals (`caco_session_swarm`, `send_caco_message`, `list_models`)

Status: done

Three removals of differing confidence. Each is independent.

---

## 1. `caco_session_swarm` — remove entirely (high confidence)

Already hidden (in `DEFAULT_DISABLED_TOOLS`); the built-in `task` tool and
`create_caco_session` cover fan-out. Delete the capability, not just the registration.

### Plan
1. Delete `src/swarm-tool.ts`.
2. Remove its import + `createSwarmTool(...)` + `...swarmTools` in `server.ts` (lines
   ~23, ~263, ~273).
3. Remove `'caco_session_swarm'` from `DEFAULT_DISABLED_TOOLS` (`src/tool-registry.ts`).
4. Remove the `adhoc.swarmProgress` emit AND its **frontend wiring**:
   `public/ts/swarm-progress.ts` (whole file, ~1-68) and its hookup in
   `public/ts/main.ts` (~lines 30, 181).
5. Update `tests/unit/tool-registry.test.ts` (the disabled-defaults assertions name
   swarm).
6. `npm run build`.

### Acceptance
No `swarm` references in `src/` or `public/ts/`, no `adhoc.swarmProgress` producer or
consumer; gate green.

---

## 2. `send_caco_message` — remove (high confidence)

Fire-and-forget messaging to an existing session. Per decision it is always a worse
choice than `caco_session_delegate` (which waits and returns the reply).
`create_caco_session(initialMessage)` covers "start a new autonomous session." The only
lost niche is "poke an existing session without waiting" — accepted.

### Considerations
- Keep the `POST /api/sessions/:id/messages` route (used by `delegate` and
  `create_caco_session`).
- `send_caco_message` lives in `src/agent-tools.ts` alongside `get_session_state`,
  `list_models`, `create_caco_session`; remove only the one tool + its export from the
  returned array.
- It is named in **live tool text**, not just prose: the `create_caco_session` /
  `send_caco_message` contrast (`src/agent-tools.ts:~196-199`), the delegate tool
  description (`src/delegate-tool.ts:28-30`), and the system-prompt "Caco Session Tools"
  line. Reword all three.

### Plan
1. Delete the `sendCacoMessage` `defineTool` block in `src/agent-tools.ts` and drop it
   from the returned tools.
2. Update descriptions + system prompt referencing it.
3. `npm run build`.

### Acceptance
Tool unregistered; `/messages` route intact; delegate + create still work; gate green.

---

## 3. `list_models` — remove, fold model ids into `create_caco_session` (recommended)

### Analysis
`list_models` is a thin wrapper over `GET /api/models` →
`sessionManager.getModels()` (the SDK's model list). There is **no SDK agent-facing tool**
it duplicates, but the data has exactly one consumer: the `model` param of
`create_caco_session`. So it is a whole tool whose only job is to feed a sibling tool's
argument.

### Recommendation
Remove `list_models`; surface a **live, compact model-id list inside
`create_caco_session`'s description**, generated from `sessionManager.getModels()` when
the tool is built. Single source of truth, one fewer tool, and the ids are right where
they are needed.

- Tradeoff: tool descriptions are built once per session start, so the list is as fresh
  as session creation — models change rarely, so this is acceptable. If staleness ever
  matters, `create_caco_session` can still return an "unknown model — available: …" error
  listing current ids (cheap, on-demand, no separate tool).
- Keep the `GET /api/models` route — it has non-tool consumers (the UI and the
  `model-info` applet, `applets/model-info/script.js:~59-63`). Only the agent-facing tool
  is removed.

### Plan
1. In `src/agent-tools.ts`, build `create_caco_session`'s description with a short
   `getModels()` id list (id + one-line role hint); remove the `list_models` tool.
2. On unknown `model`, have `create_caco_session` return an error enumerating current
   model ids (keeps discovery without the tool).
3. Update the `model` param help ("Use list_models" → "see this tool's description").
4. `npm run build`.

### Acceptance
`list_models` unregistered; `create_caco_session` description lists current model ids and
errors helpfully on an unknown id; gate green.
