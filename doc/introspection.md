# Caco agent introspection

## core question
How can Caco agents learn about the front-end features and applets to do useful things for the user?

## current state

**What exists:**
- Applets stored in `~/.caco/applets/<slug>/meta.json`
- `list_applets` tool returns: `{ slug, name, description, paths }`
- Agent can emit markdown links: `[Open](/?applet=git-status&path=/repo)`

**What's missing:**
- Agent doesn't know URL param schema for each applet
- Agent doesn't know WHEN to suggest an applet
- No way to discover applet capabilities at runtime

## design options

### Option A: Enhanced meta.json with URL schema

Add `params` field to meta.json:

```json
{
  "slug": "git-status",
  "name": "Git Status",
  "description": "View git repository status",
  "params": {
    "path": { "required": true, "description": "Absolute path to git repository" }
  },
  "triggers": ["git status", "show changes", "what files changed"]
}
```

**Pros:** Self-describing, no code changes needed per applet
**Cons:** Agents still need to call `list_applets` first

### Option B: `discover_applets` tool with rich output

New tool that returns applet info formatted for LLM context:

```
## Available Applets

### git-status
View git repository status
URL: /?applet=git-status&path=/path/to/repo
Params: path (required) - repository path

### git-diff  
View file diffs
URL: /?applet=git-diff&path=/repo&file=path/file&staged=0|1
Params: path (required), file (required), staged (optional)
```

**Pros:** Single tool call gives agent full knowledge
**Cons:** May bloat context if many applets

### Option C: System prompt injection

On session start, inject available applets into system prompt:

```
You have access to these applets (provide markdown links):
- git-status: /?applet=git-status&path=<repo>
- git-diff: /?applet=git-diff&path=<repo>&file=<file>
- image-viewer: /?applet=image-viewer&file=<path>
```

**Pros:** Always available, no tool call needed
**Cons:** Static, doesn't update when applets change

### Option D: Hybrid - meta.json + system prompt summary

1. Applets define params in meta.json
2. On server start, generate applet summary
3. Include in session system prompt
4. `list_applets` tool for detailed inspection

## recommended approach

**Option D (Hybrid)** with minimal system prompt footprint:

1. **Enhance meta.json** with `params` (URL schema):
   ```json
   {
     "slug": "git-status",
     "name": "Git Status", 
     "description": "View git repository status with staging controls",
     "params": {
       "path": { "required": true, "description": "Repository path" }
     }
   }
   ```

2. **Minimal system prompt** - one line per applet, encourage tool use:
   ```
   ## Applets
   Use list_applets tool for full details. Available: git-status, git-diff, image-viewer, text-editor, file-browser, jobs
   ```

3. **`list_applets` returns rich info** including params for link construction

### System prompt budget considerations

System prompt is premium context space. Keep applet summary minimal:
- **Bad:** Full param schemas, triggers, examples per applet (~50 tokens each)
- **Good:** Slug list only + "use list_applets for details" (~20 tokens total)

Strong models reason from slug names. When agent needs to link:
1. Recognize need from context (e.g., "show git status")
2. Call `list_applets` once to get params
3. Construct link with correct params

This trades one tool call for significant context savings.

## example scenarios

| Scenario | Agent action |
|----------|--------------|
| User says "show git status" | Emit `[View git status](/?applet=git-status&path=/cwd)` |
| User says "what changed in app.ts" | Emit `[View diff](/?applet=git-diff&path=/cwd&file=app.ts)` |
| Agent generates image | Emit `[View image](/?applet=image-viewer&file=/tmp/output.png)` |
| Large command output | Save to tmp file, emit `[View output](/?applet=text-editor&file=/tmp/output.txt)` |
| Brainstorming | Create scratch file, emit `[Edit together](/?applet=text-editor&file=/tmp/brainstorm.md)` |

## implementation tasks

1. [x] Define meta.json `params` schema
2. [x] Add `params` to all existing applet meta.json files
3. [x] Create `getAppletSlugsForPrompt()` in applet-store.ts
4. [x] Inject applet list into session system prompt (server.ts)
5. [x] Update `GET /api/applets` to return params

## implementation summary

**Files changed:**
- `src/applet-store.ts` - Added `params` to `AppletMeta` interface, added `getAppletSlugsForPrompt()`
- `src/routes/api.ts` - Added `params` to list response
- `server.ts` - System message now built async with applet discovery

**Applet meta.json updates:**
- git-status, git-diff, image-viewer, text-editor, file-browser, jobs - all have `params` field

**System prompt injection:**
```
## Applets
Available applets: git-status, git-diff, image-viewer, text-editor, file-browser, jobs. Use list_applets tool for URL params and details.
Provide clickable markdown links: [View status](/?applet=git-status&path=/repo)
```

## decisions

1. **Text-editor editing:** Yes, allow editing. Useful for brainstorming, scratch files, agent collaboration.
2. **Applets added mid-session:** Out of scope. Session uses applets known at start.
3. **Triggers usage:** Documentation only. Strong agents reason from description; no automatic matching.
