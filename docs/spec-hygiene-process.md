# spec-hygiene-process

A repeatable process to keep `docs/` accurate and conformant: normalize naming,
evict non-specs, consolidate drifted clusters, and ratchet against regression.
This doc is the playbook; the live counts below are a dated snapshot, not state.

## Goals

Any contributor (human or agent) can run a hygiene pass that leaves every spec
in `docs/` named `spec-*`/`*-spec`, structured to the create-spec-plan skeleton,
and code-accurate — with non-specs moved out and obsolete docs archived, never
deleted. The conformance checker stays green and can only ratchet tighter.

## Design

Two oracles drive everything: **`tools/check-spec-conformance.mjs`** (objective
structure — headings, order, required sections) and a **reviewer session**
(subjective content — is each claim true vs code, are oracles real). The work
splits into safe per-file fan-out and unsafe cross-file consolidation.

**Five phases**, run in order; each is independently shippable.

| Phase | What | Fan-out? | Gate |
|---|---|---|---|
| 0 Inventory | `--inventory` classifies every doc: spec / spec(unmarked) / guide / research / other, with cluster size, inbound-ref count, git age, conformance, suggested disposition. | one pass | the table |
| 1 Triage | One disposition per doc: KEEP / RENAME / CONSOLIDATE→target / ARCHIVE / MOVE→guides\|research. Agent proposes; human signs off product-judgment calls (parked ideas). | cheap human | sign-off |
| 2 Normalize | Rename survivors to `spec-<slug>`; fix headings/order; repoint inbound refs. | **yes, safe** | checker green |
| 3 Deep conform | Per spec: ground vs code → reviewer pass → fold MUSTs → fill Invariants/Acceptance/Plan-table. | **yes, 1 agent/spec** | reviewer + checker |
| 4 Consolidate | Each drifted cluster → one as-built root spec (+sub-specs); archive the series. | **no, serial+reviewed** | spec review before delete |

Mechanism: classification is heuristic (filename markers win; else infer from
skeleton headings + keyword regex), chosen over a manual list so it self-updates
as docs change. The checker is zero-dep Node ESM (portable).

## Invariants

- **Never hard-delete** (invariant): `git rm` (recoverable) or move to
  `docs/archive/`; history is the safety net.
- **Phase 4 is not fan-out-able** (invariant): deciding what's still true across a
  cluster is cross-document judgment and *loses information* — serial + reviewed,
  like files-applet and tool-diet/budget.
- **Runtime doc discovery must survive moves** (invariant): `caco_docs` resolves a
  doc by short basename recursively (`dev-docs-tool.ts`), so relocating into
  `guides/`/`research/`/`archive/` never breaks by-name reads. Verify after any move.
- **Checker surface = real specs only** (fact): non-specs leave `docs/` root so the
  checker judges specs, not guides/research.
- **Ratchet** (mechanism): the checker runs in the `build` script (`check:specs`),
  so the pre-push hook and CI both fail on any non-conforming spec. At zero
  out-of-conformance no allowlist is needed; `--no-verify` is the WIP escape hatch.
  It gates STRUCTURE, not truth — a conforming spec can still lie about code.

## Considerations

- **Soft signals, not gospel.** The `title not spec-<slug>` flag fires on nearly all
  legacy docs; the discriminating signals are missing-required-sections + synonyms.
  Inbound-ref count and git age inform KEEP-vs-archive (e.g. `search`/`memory` are
  old but high-inbound → keep), not the structural verdict.
- **Folders Caco reads at runtime.** `docs/guides/` and `docs/research/` are read by
  `caco_docs`; keep them discoverable (the recursive resolver), don't bury them.
- **Consolidation provenance.** A consolidated root spec records what it absorbed in
  its Rationale; the archived originals keep their sibling links rewritten.

## Risks and Mitigations

- Relocate breaks runtime reads → recursive basename resolver + a live fetch check post-move.
- Consolidation drops still-true facts → write the new root spec from CODE first, then archive; spec review before deleting originals.
- Over-eager classification mislabels a doc → human triage gate (Phase 1) before any move.

## Acceptance

- Observable: `node tools/check-spec-conformance.mjs --inventory` shows class=spec for everything in `docs/` root (minus declared KEEP); `… ` (conformance) trends toward 0 out-of-conformance.
- Budgets: n/a.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client (Phases 2–4 touch code comments/doc-resolver).
- Oracles: the checker itself (structure); a reviewer-session pass per spec (content); a live `caco_docs section="<moved-doc>"` fetch (resolver).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Inventory baseline | `tools/check-spec-conformance.mjs --inventory` | the table |
| 2 | Triage dispositions (human sign-off) | — | sign-off |
| 3 | Mechanical batch: rename + archive + relocate + repoint | `git mv`, `sed`; `dev-docs-tool.ts` if moving runtime docs | checker green + live fetch |
| 4 | Consolidate each drifted cluster (serial) | new `spec-<root>.md`; archive series | spec review before delete |
| 5 | Per-spec deep conform (fan-out) | each `docs/spec-*.md` | reviewer MUSTs folded |
| 6 | Ratchet: gate in `build` script (pre-push + CI) | `package.json` `check:specs` | checker exit code |

## Rationale

### Live snapshot (2026-06-29)

After Phases 0–2 + the five consolidations + relocations:

| Location | Count |
|---|---|
| `docs/` root (specs + 2 KEEP) | 67 |
| `docs/archive/` | 21 |
| `docs/research/` | 13 |
| `docs/guides/` | 3 |

Conformance: **66 conforming, 0 out** — every spec passes the skeleton check, now
enforced by `npm run check:specs` in the `build` gate (pre-push + CI).
`spec(unmarked) = 0` — every spec is marked. Phases 0–6 complete.

History: this process was derived while consolidating the files-applet (~60 docs →
3), tool-diet (3 → `spec-budget`, which later absorbed model-billing /
session-throughput / transparent-usage), multi-provider → `byok-spec`, and the
chat cluster (6 → `spec-chat-form`). Those are the worked examples of Phase 4.
