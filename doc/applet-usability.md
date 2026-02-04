# Applet Usability for Agents

## Problem

Agents don't reliably use applets because:
1. **Discovery gap**: System prompt says "Available applets: git-status, ..." but lacks param schemas
2. **Copilot CLI sessions**: No system prompt injection—agents start with zero applet knowledge
3. **User-oriented docs**: `params` descriptions are for humans, not agents
4. **Tool naming**: `applet_howto` is about *creating* applets, not *using* them

## Current State

```
System prompt:  "Available applets: git-status, git-diff, ..."
                "Use list_applets tool for URL params and details."

GET /api/applets: Returns { slug, name, description, params, paths }

Tools:          applet_howto (creation docs)
                get_applet_state, set_applet_state (runtime)
```

**Missing**: Tool for agents to discover "how do I show X to the user via applet?"

## Proposal

### 1. New tool: `caco_applet_usage`

Returns agent-oriented usage examples for all applets.

```typescript
defineTool('caco_applet_usage', {
  description: 'Get applet usage information. Returns URL patterns and examples for linking users to applets. Call this when you want to show something to the user via an applet.',
  
  parameters: z.object({
    slug: z.string().optional().describe('Get info for specific applet only')
  }),
  
  handler: async ({ slug }) => {
    const applets = await listApplets();
    const filtered = slug ? applets.filter(a => a.slug === slug) : applets;
    
    const usage = filtered.map(a => formatAppletUsage(a)).join('\n\n');
    return { textResultForLlm: usage };
  }
});
```

**Output format** (agent-oriented):

```
## text-editor
Show/edit a text file.
Link: [View file](/?applet=text-editor&path=/absolute/path/to/file.txt)
Required: path (absolute file path)

## git-diff
Show file diff in a git repository.
Link: [View diff](/?applet=git-diff&path=/repo&file=relative/file.ts)
Required: path (repo root), file (relative to repo)
Optional: staged=1 (show staged diff)

## git-status
Show git repository status with staging controls.
Link: [View status](/?applet=git-status&path=/repo)
Required: path (repo root)

## image-viewer
Display an image file.
Link: [View image](/?applet=image-viewer&file=/path/to/image.png)
Required: file (absolute image path)
```

### 2. Enhanced meta.json: `agentUsage` field

Add agent-oriented examples to meta.json:

```json
{
  "slug": "text-editor",
  "name": "Text Editor",
  "description": "Edit text files with syntax highlighting",
  "params": {
    "path": { "required": true, "description": "Absolute path to text file" }
  },
  "agentUsage": {
    "purpose": "Show or edit a text file",
    "example": "[View file](/?applet=text-editor&path=/path/to/file.txt)",
    "triggers": ["show file", "edit file", "view source", "open in editor"]
  }
}
```

### 3. Rename `applet_howto` → `caco_applet_howto`

Clarify this is for **creating** applets:

```typescript
defineTool('caco_applet_howto', {
  description: 'Get documentation for CREATING new applets. Call when user asks to build a custom widget, dashboard, or interactive UI. For using existing applets, use caco_applet_usage instead.',
  // ...
});
```

### 4. System prompt enhancement

Current (minimal, good):
```
Available applets: git-status, git-diff, ...
Use list_applets tool for URL params and details.
```

Proposed (add agent hints):
```
## Applets
Interactive UI panels. Provide markdown links to open for users.
Available: git-status, git-diff, text-editor, image-viewer, file-browser, jobs
Use `caco_applet_usage` to get URL patterns and examples.
Common: [View file](/?applet=text-editor&path=/file) | [Git status](/?applet=git-status&path=/repo)
```

### 5. Repository structure change

Move applets into main repo, symlink from ~/.caco:

```
caco/
├── applets/           # Source of truth
│   ├── text-editor/
│   ├── git-status/
│   └── ...
└── ...

~/.caco/
├── applets -> /path/to/caco/applets  # Symlink
├── sessions/
└── usage.json
```

**Benefits:**
- Version control for built-in applets
- PRs can modify applets
- User can still add custom applets (check for real dir vs symlink)

**Implementation:**
1. `mv ~/.caco/applets/* /path/to/caco/applets/`
2. `rm -rf ~/.caco/applets && ln -s /path/to/caco/applets ~/.caco/applets`
3. Update install instructions

## Implementation Plan

| Task | Effort | Status |
|------|--------|--------|
| Add `caco_applet_usage` tool | Medium | ✅ Done |
| Add `agentUsage` to all meta.json | Low | ✅ Done |
| Rename `applet_howto` → `caco_applet_howto` | Low | ✅ Done |
| Update system prompt with applet hints | Low | ✅ Done |
| Unit test for `formatAppletUsage` | Low | ✅ Done |
| Add `stateSchema` to meta.json | Low | ✅ Done |
| Include state in `caco_applet_usage` output | Low | ✅ Done |
| Move applets to repo + symlink | Medium | Phase 4 |

## get_applet_state / set_applet_state Schemas

For applet developers, document the expected state shapes:

```json
// text-editor: get_applet_state returns
{
  "path": "/current/file.txt",
  "content": "file contents...",
  "modified": true
}

// git-status: get_applet_state returns  
{
  "path": "/repo/path",
  "staged": ["file1.ts"],
  "unstaged": ["file2.ts"],
  "untracked": ["file3.ts"]
}
```

These should be documented in each applet's meta.json:

```json
{
  "stateSchema": {
    "output": {
      "path": "string - current file path",
      "content": "string - file contents",
      "modified": "boolean - has unsaved changes"
    },
    "input": {
      "content": "string - set file content (triggers reload)"
    }
  }
}
```

## Success Criteria

1. Copilot CLI sessions can discover applet usage via tool call
2. Agents reliably emit correct applet links without trial and error
3. Tool names clearly distinguish "create applet" vs "use applet"
4. Built-in applets are version-controlled in main repo

## Tool Discovery Model

**What agents see on every request:**
- Tool definitions: `name` + `description` + `parameters` schema
- System prompt (if configured—NOT available in Copilot CLI sessions)
- Conversation history

**What agents don't see until they call:**
- Tool output (e.g., `caco_applet_usage` results)

**Discovery priority:**
1. **Tool name** — Primary scan target. Must contain discoverable keywords.
2. **Tool description** — Read when considering whether to call.
3. **System prompt** — Hints that point to tools (Caco sessions only).

**Implication**: For Copilot CLI compatibility, tool names must be self-describing. `caco_applet_usage` is better than `list_applets` because "usage" signals "how to use."

---

## Implementation Phases

### Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Breaking change**: Renaming `applet_howto` breaks existing prompts/docs | Medium | Keep old name as alias initially, deprecate in docs |
| **Import cycle**: `caco_applet_usage` needs `listApplets` from applet-store | Low | Already imported in applet-tools, no new deps |
| **Type safety**: `agentUsage` field not in `AppletMeta` interface | Low | Extend interface before accessing |
| **Missing meta.json fields**: Old applets lack `agentUsage` | Low | Use fallback to `description` |
| **Test coverage**: New tool not tested | Medium | Add unit test for `formatAppletUsage` |
| **System prompt bloat**: Adding examples increases token usage | Low | Keep examples minimal (~30 tokens) |

### Unknowns

| Unknown | Resolution |
|---------|------------|
| Does Copilot CLI always include tool definitions? | Yes - confirmed by SDK behavior |
| Max tool description length before truncation? | Unknown, keep under 200 chars |
| Will agents prefer `caco_*` prefix tools? | Test with fresh session |

---

### Phase 1: Core Discovery (High Priority)

**Goal**: Agents can discover and use applets from tool definitions alone.

**1.1 Add `caco_applet_usage` tool**

File: `src/applet-tools.ts`

```typescript
const cacoAppletUsage = defineTool('caco_applet_usage', {
  description: 'Get applet URL patterns for linking users to interactive panels. Returns example markdown links for each applet. Call this when you want to show files, diffs, git status, or other content to the user via an applet.',
  
  parameters: z.object({
    slug: z.string().optional().describe('Filter to specific applet')
  }),
  
  handler: async ({ slug }) => {
    const applets = await listApplets();
    const filtered = slug ? applets.filter(a => a.slug === slug) : applets;
    const usage = filtered.map(formatAppletUsage).join('\n\n');
    return { textResultForLlm: usage || 'No applets installed.' };
  }
});
```

Helper function:
```typescript
function formatAppletUsage(applet: AppletMeta): string {
  const params = Object.entries(applet.params || {});
  const required = params.filter(([, v]) => v.required).map(([k]) => k);
  const optional = params.filter(([, v]) => !v.required).map(([k]) => k);
  
  // Build example URL
  const exampleParams = params.map(([k, v]) => 
    `${k}=${v.required ? `<${k}>` : `[${k}]`}`
  ).join('&');
  
  return `## ${applet.slug}
${applet.agentUsage?.purpose || applet.description}
Link: \`[${applet.name}](/?applet=${applet.slug}&${exampleParams})\`
${required.length ? `Required: ${required.join(', ')}` : ''}
${optional.length ? `Optional: ${optional.join(', ')}` : ''}`.trim();
}
```

**1.2 Add `agentUsage` to meta.json for all applets**

Add to each applet's meta.json:

```json
{
  "agentUsage": {
    "purpose": "Show or edit a text file",
    "example": "[View file](/?applet=text-editor&path=/path/to/file.txt)"
  }
}
```

Applets to update:
- `text-editor`: "Show or edit a text file"
- `git-status`: "Show git repository status with staging controls"
- `git-diff`: "Show file diff in a git repository"
- `image-viewer`: "Display an image file"
- `file-browser`: "Browse directory contents"
- `jobs`: "View scheduled agent jobs"
- `calculator`: "Perform calculations"
- `drum-machine`: "Play drum beats"
- `applet-browser`: "Browse and launch applets"

**1.3 Rename `applet_howto` → `caco_applet_howto`**

Update name and description:

```typescript
defineTool('caco_applet_howto', {
  description: 'Get documentation for CREATING new applets (HTML/JS/CSS widgets). Call when user asks to build a custom dashboard, form, or interactive component. For USING existing applets, call caco_applet_usage instead.',
  // ...
});
```

Update references:
- `server.ts` system prompt
- `doc/API.md`

**Status: ✅ Complete** (included in Phase 1 implementation)

---

### Phase 2: Enhanced Discovery (Medium Priority)

**Goal**: Improve system prompt for Caco sessions.

**2.1 Update system prompt**

In `server.ts`, change applet section:

```typescript
## Applets
Interactive panels for users. Provide markdown links.
${appletPrompt || 'No applets. Use caco_applet_howto to create one.'}
Examples: [View file](/?applet=text-editor&path=/file) | [Git status](/?applet=git-status&path=/repo)
Call \`caco_applet_usage\` for all applet URL patterns.
```

**Status: ✅ Complete** (included in Phase 1 implementation)

---

### Phase 3: State Documentation (Medium Priority)

**Goal**: Agents know what state applets expose/accept.

**3.1 Add `stateSchema` to meta.json**

```json
{
  "stateSchema": {
    "get": {
      "path": "string - current file path",
      "modified": "boolean - has unsaved changes"
    },
    "set": {
      "content": "string - update file content"
    }
  }
}
```

**3.2 Include in `caco_applet_usage` output**

```
## text-editor
...
State (get_applet_state): path, content, modified
State (set_applet_state): content
```

**Status: ✅ Complete**

---

### Phase 4: Repository Structure (Low Priority)

**Goal**: Version-control built-in applets.

**4.1 Move applets to repo**

```bash
# Copy applets to repo
cp -r ~/.caco/applets/* /path/to/caco/applets/

# Replace with symlink
rm -rf ~/.caco/applets
ln -s /path/to/caco/applets ~/.caco/applets
```

**4.2 Update .gitignore**

Ensure applets are tracked:
```
# Don't ignore applets/
!applets/
```

**4.3 Handle custom applets**

When user creates applet, detect symlink and create in repo:
```typescript
// In save_applet handler
const appletsDir = getAppletsDir();
const realPath = await fs.realpath(appletsDir);
// Write to realPath to ensure it goes to repo
```

---

## Validation Checklist

After each phase, verify:

- [ ] **Phase 1**: Fresh Copilot CLI session can call `caco_applet_usage` and emit correct link
- [ ] **Phase 2**: Caco session knows applets from system prompt hints
- [ ] **Phase 3**: Agent can read `text-editor` state and update content via `set_applet_state`
- [ ] **Phase 4**: `git status` shows applets as tracked files
