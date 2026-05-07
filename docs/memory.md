# Persistent Memory

## Goal

Cross-session key-value memory that persists user preferences, project context, and learned facts. Agents can safely add/update/remove individual entries without needing context about other entries.

## Storage

`~/.caco/memory.json` — JSON object, key-value pairs.

```json
{
  "preferred-language": "TypeScript, functional style",
  "git-commits": "Facts only, no attribution trailers, no verbose explanations",
  "caco-repo": "~/repo/caco — self-extensible Copilot frontend",
  "no-emoji": "Do not use emoji in responses"
}
```

Keys: slug format (lowercase, numbers, hyphens). Validated on write — reject non-slug keys.
Values: short strings, one fact per key. No length limit but conciseness is encouraged.
Capacity: 50 entries max. Hard-enforced on write.

## Tools

### `caco_get_memory`

Returns all entries + capacity stat. No parameters.

```json
{
  "entries": {
    "preferred-language": "TypeScript, functional style",
    "git-commits": "Facts only, no attribution"
  },
  "count": 2,
  "capacity": 50
}
```

### `caco_set_memory`

Set or remove a single entry.

Parameters:
- `key` (string, required) — slug format, rejected if invalid
- `value` (string, optional) — the fact to store. Empty or omitted = delete the key.

Returns: `{ ok: true, count: N, capacity: 50 }` or error.

Errors:
- Invalid key format (not slug)
- At capacity (50) when adding a new key (updating existing keys always succeeds)

## Injection

### New sessions

`buildSystemMessage()` reads `~/.caco/memory.json` and appends a `## User Memory` section listing all entries as `- **key**: value` bullet points.

### Resumed sessions

`resumeSession()` passes `systemMessage: { mode: 'append', content }` with memory contents. The SDK's `ResumeSessionConfig` accepts this field — the local interface needs updating to include it.

### Format in prompt

```
## User Memory
- **preferred-language**: TypeScript, functional style
- **git-commits**: Facts only, no attribution trailers
```

At 50 entries averaging 60 chars each, this is roughly 500 tokens. Well within budget.

## System prompt section

```
## Memory
Persistent key-value memory across all sessions.
- `caco_get_memory` — Read all stored memories (returns entries + capacity)
- `caco_set_memory` — Store or remove a memory (key + value, empty value = delete)
Keys are slugs (lowercase, hyphens, numbers). One concise fact per key.
When the user says "remember", "forget", "always", or "never" about a preference, update memory.
Memory is loaded into your context at session start. Use `caco_get_memory` for the latest version if memory may have changed since session start.
```

## Implementation

### Step 1: Memory tool

`src/memory-tool.ts`:
- `caco_get_memory`: read `~/.caco/memory.json`, return entries + count + capacity
- `caco_set_memory`: validate slug key, read file, update/delete entry, enforce capacity, write back, return count
- Handle ENOENT (first-time user) — return empty entries
- Write backup to `memory.json.bak` before overwriting

Wire into `server.ts` toolFactory.

### Step 2: Prompt injection

`src/prompts.ts`: read memory, format as bullet list, append to system message.
`src/session-manager.ts`: update local `ResumeSessionConfig` interface, pass `systemMessage: { mode: 'append', content }` at both resume call sites.

### Step 3: Build, test, acceptance

Unit tests: get/set/delete/capacity/invalid-key/ENOENT.
Manual: "remember I prefer TypeScript" → check memory.json → new session → agent knows.

## Risks

1. **Resume systemMessage append** — SDK accepts it in types but untested in Caco. Verify empirically. Fallback: agent calls `caco_get_memory` manually.
2. **Concurrent writes** — two agents writing different keys simultaneously could race on file read-write. Low probability (memory writes are rare). Mitigated by backup file.
3. **Agent key collisions** — different agents may use different keys for the same concept. Acceptable — 50 slots is enough headroom, and agents seeing existing keys via `caco_get_memory` naturally avoids duplicates.
