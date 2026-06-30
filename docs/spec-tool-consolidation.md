# Spec: Tool consolidations (surface ack, docs root)

Status: done

Two independent consolidations. Implement in either order.

## Goals

**A:** Remove `caco_clear_surface_changes`; ack-only path becomes ops-less `caco_mutate_surface`, routing through the store `clearChanges` to preserve byte-exact missing-doc and stale-token semantics.  
**B:** Collapse `caco_dev_docs`, `caco_applet_howto`, `caco_applet_usage`, `caco_extensions` into one `caco_docs` tool with a `section` namespace; cut three tool descriptions from every turn.

## Design

### A. Fold `caco_clear_surface_changes` into `caco_mutate_surface`

- The ack-only path must stay **byte-equivalent to today's `clearChanges`**, which is NOT
  the same as calling `mutate()` with empty ops: `mutate()` materializes a new empty doc
  when none exists (`surface-store.ts:~120-123, ~173-220`), whereas `clearChanges()`
  returns `{ ok:false, reason:'unknown-item' }` for a missing doc (`~247-259`). So:
  - **Keep the store-level `clearChanges` function.** In the `caco_mutate_surface` tool
    handler, when no `create`/`update`/`delete` is supplied, route to `clearChanges`
    (NOT to `mutate()`), preserving the missing-doc and stale-token semantics exactly.
  - With ops present, behavior is unchanged (route to `mutate`, which already clears
    `changes` on success).
- Delete the `caco_clear_surface_changes` tool only; its store function lives on, now
  reached via ops-less `caco_mutate_surface`.
- Reword `caco_mutate_surface` and `caco_get_surface_changes` descriptions: the ack path
  is now "mutate with no items" (drop all `caco_clear_surface_changes` references).

### B. Merge four doc tools into one `caco_docs`

`caco_dev_docs` already has the right shape (`section?`, `viewRange?`, with `"index"` and
filename routing). Generalize it into `caco_docs` and add **virtual sections** that
return the other three tools' bodies:

| `section` value        | Returns (today's source)                              |
|------------------------|-------------------------------------------------------|
| omitted                | dev guide (`DEV_DOCS`)                                 |
| `index`                | doc-file index (unchanged)                            |
| `<filename>`           | a root/`docs/` markdown file (unchanged)              |
| `applets:create`       | `APPLET_HOWTO` (was `caco_applet_howto`)              |
| `applets:usage`        | applet usage list (was `caco_applet_usage`); honors `slug` |
| `extensions`           | extensions guide (was `caco_extensions`)              |

- Add an optional `slug?` param (only meaningful for `applets:usage`).
- `caco_docs` with no args lists the virtual sections at the top of the dev guide so the
  agent can discover `applets:create` / `applets:usage` / `extensions` without prose.
- Move the three bodies/handlers into the `caco_docs` module (or have it import the
  existing builders). Delete the three standalone tools and their `server.ts`
  imports/wiring; remove `caco_extensions` from `DEFAULT_DISABLED_TOOLS`.
- Update every cross-reference that names the old tools — system prompt
  (`caco_applet_usage`/`caco_applet_howto`), surface tool descriptions
  (`caco_dev_docs section="surface-cookbook"`), `EXTENSIONS.md`, etc. — to `caco_docs`.

## Considerations

- `caco_applet_usage`'s `slug` filtering + deprecation messaging must be preserved under
  `applets:usage`, **including the "no applets installed" branch** whose text currently
  names `caco_applet_howto` (`src/applet-tools.ts:~437-442`) — reword to point at
  `caco_docs section="applets:create"`.
- Keep `viewRange` working for filename sections; virtual sections ignore it.
- One tool now owns applet + extension + project docs; its description must briefly
  enumerate the section namespace so discovery doesn't regress.

## Acceptance

### A. caco_clear_surface_changes removal

- Ops-less `caco_mutate_surface({dataToken})` on a doc with pending `changes` → `ok:true`,
  `changes` emptied, new `dataToken`. Byte-equal to the old `clearChanges` result.
  (reference: `tests/unit/surface-store.test.ts` `clearChanges` cases)
- **Missing doc**: ops-less mutate returns `{ ok:false, reason:'unknown-item' }` (NOT a
  newly-materialized empty doc) — proves routing through `clearChanges`, not `mutate()`.
- Stale token → `{ ok:false, reason:'stale', currentDataToken }`, `changes` untouched.
- Concurrent-writer race behaves as the old `clearChanges`.
- `caco_clear_surface_changes` no longer registered; gate green.

### B. caco_docs consolidation

- `caco_docs({section:'applets:create'})` byte-equals old `caco_applet_howto`. (golden)
- `caco_docs({section:'applets:usage', slug})` equals old `caco_applet_usage` output for
  the same slug, including the deprecated/not-found branches. (golden + hand cases)
- `caco_docs({section:'extensions'})` equals old `caco_extensions`. (golden)
- Existing `caco_dev_docs` behaviors (`index`, filename, `viewRange`) unchanged. (golden)
- No references to the four old tool names remain in `src/`, prompts, or docs; gate green.

## Plan

### A. caco_clear_surface_changes removal

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Add case: ops-less `mutate` ≡ `clearChanges`, incl. missing-doc `unknown-item` branch | `tests/unit/surface-store.test.ts` | test: new clearChanges parity case |
| 2 | Route no-ops case in handler to store `clearChanges`; ops-present unchanged | `src/surface-tools.ts` | oracle from step 1 |
| 3 | Delete `caco_clear_surface_changes` tool | `src/surface-tools.ts` | gate: knip + build |
| 4 | Reword `caco_mutate_surface` + `caco_get_surface_changes` descriptions | `src/surface-tools.ts` | - |
| 5 | `npm run build` | - | green |

### B. caco_docs consolidation

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Rename `caco_dev_docs` → `caco_docs`; add `slug?` + virtual-section switch | `src/dev-docs-tool.ts` | - |
| 2 | Add section namespace to description + list in no-arg dev guide | `src/dev-docs-tool.ts` | - |
| 3 | Delete three standalone tools + server.ts wiring; drop from DEFAULT_DISABLED_TOOLS | `src/applet-tools.ts`, `src/server.ts`, `src/tool-registry.ts` | gate: knip |
| 4 | Add golden tests for virtual sections vs prior tool outputs | `tests/unit/applet-tools.test.ts` | golden comparison |
| 5 | Grep-replace old tool names in prompts/docs/surface descriptions | `src/`, `docs/` | gate: grep confirms zero refs |
| 6 | `npm run build` | - | green |
