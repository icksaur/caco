# Spec: Tool consolidations (surface ack, docs root)

Status: done

Two independent consolidations. Implement in either order.

---

## A. Fold `caco_clear_surface_changes` into `caco_mutate_surface`

### Goal
Remove `caco_clear_surface_changes`. Acking human edits without a structural write
becomes "call `caco_mutate_surface` with no create/update/delete" — `mutate` already
"atomically clears the human-side changes map."

### Design
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

### Acceptance (oracle: behavioral equivalence)
- Ops-less `caco_mutate_surface({dataToken})` on a doc with pending `changes` → `ok:true`,
  `changes` emptied, new `dataToken`. Byte-equal to the old `clearChanges` result.
  (reference vs. `surface-store.test.ts` clearChanges cases at lines ~201–228)
- **Missing doc**: ops-less mutate returns `{ ok:false, reason:'unknown-item' }` (NOT a
  newly-materialized empty doc) — proves it routes through `clearChanges`, not `mutate()`.
- Stale token → `{ ok:false, reason:'stale', currentDataToken }`, `changes` untouched.
- Concurrent-writer race behaves as the old `clearChanges`.
- `caco_clear_surface_changes` no longer registered; gate green.

### Plan
1. In `surface-store` tests, add a case asserting ops-less `mutate` ≡ `clearChanges`,
   including the missing-doc `unknown-item` branch.
2. In the `caco_mutate_surface` handler, route the no-ops case to the store `clearChanges`
   (keep `clearChanges`); ops-present case unchanged.
3. Delete the `caco_clear_surface_changes` tool in `src/surface-tools.ts`.
4. Reword the two surface tool descriptions.
5. `npm run build`.

---

## B. Merge four doc tools into one `caco_docs`

### Goal
Collapse `caco_dev_docs`, `caco_applet_howto`, `caco_applet_usage`, `caco_extensions`
into a single `caco_docs` tool with a documentation-root `section` namespace. Cuts three
tool descriptions from every turn.

### Design
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

### Considerations
- `caco_applet_usage`'s `slug` filtering + deprecation messaging must be preserved under
  `applets:usage`, **including the "no applets installed" branch** whose text currently
  names `caco_applet_howto` (`src/applet-tools.ts:~437-442`) — reword to point at
  `caco_docs section="applets:create"`.
- Keep `viewRange` working for filename sections; virtual sections ignore it.
- One tool now owns applet + extension + project docs; its description must briefly
  enumerate the section namespace so discovery doesn't regress.

### Acceptance (oracle: output equivalence per section)
- `caco_docs({section:'applets:create'})` byte-equals old `caco_applet_howto`. (golden)
- `caco_docs({section:'applets:usage', slug})` equals old `caco_applet_usage` output for
  the same slug, including the deprecated/not-found branches. (golden + hand cases)
- `caco_docs({section:'extensions'})` equals old `caco_extensions`. (golden)
- Existing `caco_dev_docs` behaviors (`index`, filename, `viewRange`) unchanged. (golden)
- No references to the four old tool names remain in `src/`, prompts, or docs; gate green.

### Plan
1. Rename `caco_dev_docs` → `caco_docs`; add `slug?` param and the virtual-section switch
   delegating to the existing howto/usage/extensions builders.
2. Add the section namespace to the tool description + list it in the no-arg dev guide.
3. Delete `caco_applet_howto`, `caco_applet_usage`, `caco_extensions` tools + their
   `server.ts` wiring; drop `caco_extensions` from `DEFAULT_DISABLED_TOOLS`.
4. Add golden tests comparing `caco_docs` virtual sections to the prior tool outputs.
5. Grep-replace old tool names in prompts/docs/surface descriptions with `caco_docs`.
6. `npm run build`.
