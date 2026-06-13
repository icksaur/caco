# Model billing — token-cost display

**Status:** spec rev 2, not implemented. Updates Caco's model UI to the
SDK's token-based billing model (effective 2026-06-01), replacing
the dead `billing.multiplier` (now always absent → renders `1x`
everywhere).

## 1. Background

GitHub Copilot moved to token-based billing on 2026-06-01. The
`@github/copilot-sdk` (1.0.0-beta.7) `Model.billing` shape
changed:

- `billing.multiplier` is now **absent** for every model. Our
  code falls back to `?? 1`, so every model shows `1x` / `free`.
- New `billing.tokenPrices`: `{ inputPrice, outputPrice,
  cachePrice, batchSize, contextMax?, longContext? }`. Prices are
  AI Credits per `batchSize` tokens; `batchSize` is 1,000,000 for
  all current models, so `inputPrice` is effectively credits per
  1M tokens. `longContext` is a separate price tier
  `{ inputPrice, outputPrice, cachePrice, contextMax }` that
  applies above `contextMax`.
- New `modelPickerPriceCategory`: `low | medium | high |
  very_high` — the SDK's intended relative-cost tier for pickers.
- New `modelPickerCategory`: `lightweight | versatile |
  powerful`.

Observed live values (credits per 1M tokens, in/out/cache):

| Model | in | out | cache | priceCat | category |
|---|---|---|---|---|---|
| claude-haiku-4.5 | 100 | 500 | 10 | low | lightweight |
| claude-sonnet-4.5/4.6 | 300 | 1500 | 30 | medium | versatile |
| claude-opus-4.5–4.8 | 500 | 2500 | 50 | high | powerful |
| gpt-5.5 | 500 | 3000 | 50 | high | powerful |
| auto | — | — | — | (none) | (none) |

`auto` has no `billing` object at all. gpt-5.5 has a long-context
tier that doubles input (500→1000) and raises output
(3000→4500) above 272k tokens.

## 2. Goals

1. `/model` slash-command picker: show price category
   (`low/medium/high/very_high`) instead of `1x`.
2. New-session model picker (`#modelList`, more real estate):
   show compact in/out per-MTOK cost, format `300:1500/Mtok`.
3. New `model-info` applet: a property-agnostic table dumping
   ALL model properties. V1 may be visually rough; the value is
   completeness, not polish.
4. Backend: `/api/models` and `/api/sessions` model arrays carry
   the new fields additively; a raw passthrough endpoint feeds
   the applet.

## 3. Non-goals

- Computing actual spend / quota burn from token counts (that's
  a usage-tracking feature, separate).
- Per-message cost estimation.
- Long-context tier UI beyond (optionally) a marker. V1 shows
  only the default tier's prices.
- Changing the model **selection** logic or ordering.
- Removing the legacy `multiplier`/`cost` fields (kept for
  back-compat; they degrade to 1).
- Theming/polish of the new applet table.

## 4. Current code (what changes)

### 4.1 Server model mapping (two sites)

- `src/routes/api.ts:37-46` — `GET /api/models` maps each SDK
  model to `{ id, name, multiplier }`.
- `src/routes/sessions.ts:145-150` — `GET /api/sessions` maps to
  `{ id, name, cost }`.

Both read `m.billing?.multiplier ?? 1`. The SDK model type is
declared locally in `src/session-manager.ts:56-65` as
`SDKModelInfo` with only `billing?: { multiplier: number }` — so
the new fields aren't even visible to TypeScript.

### 4.2 Client model type + pickers

- `public/ts/types.ts:14-18` — `ModelInfo { id, name, cost }`.
- `public/ts/model-selector.ts:72-92` — new-session badge:
  renders `free` / `${cost}x` / premium tiers from `cost`.
- `public/ts/command-registry.ts:140-144` — `/model` picker:
  description is `${m.cost}x` (or `free`).

### 4.3 Applet pattern

Applets are directories under `applets/<slug>/` with
`meta.json`, `content.html`, `script.js`, `style.css`. They get
a generic `window.appletAPI.fetch(url)` wrapper (see
`public/ts/applet-runtime.ts:269`) and
`appletAPI.setAppletState(...)`. `applet-browser` is the
reference minimal read-only applet (it calls
`appletAPI.listApplets()` then renders a list).

## 5. Design

### 5.1 SDK type declaration (session-manager.ts)

`SDKModelInfo` is currently a **private** interface in
`src/session-manager.ts`. The new `src/model-billing.ts` helper
needs the type. Resolution: **export `SDKModelInfo` from
`session-manager.ts`** and import it in `model-billing.ts`. (The
alternative — a structural `ModelBillingSource` type local to
`model-billing.ts` — is rejected to keep one model type, not
two.)

Extend `SDKModelInfo` to mirror the real SDK `Model` shape for
the fields we consume. Note the SDK marks `capabilities.supports`
and `capabilities.limits` (and the limit sub-fields) optional,
so mirror that optionality rather than asserting presence:

```
export interface SDKModelInfo {
  id: string;
  name: string;
  capabilities?: {
    supports?: { vision?: boolean; reasoningEffort?: boolean };
    limits?: { max_context_window_tokens?: number;
               max_prompt_tokens?: number;
               max_output_tokens?: number; };
  };
  policy?: { state: string; terms?: string };
  billing?: {
    multiplier?: number;
    tokenPrices?: {
      inputPrice?: number; outputPrice?: number; cachePrice?: number;
      batchSize?: number; contextMax?: number;
      longContext?: { inputPrice?: number; outputPrice?: number;
                      cachePrice?: number; contextMax?: number; };
    };
  };
  modelPickerCategory?: 'lightweight' | 'versatile' | 'powerful';
  modelPickerPriceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}
```

This is the **minimal consumed subset** of the SDK `Model` type,
not an exhaustive mirror — the raw applet (§5.8) sees the full
runtime object regardless of what this interface declares.
(No current code reads `capabilities.limits.max_context_window_tokens`
off a model, so widening these to optional breaks no consumer —
verified by grep.)

### 5.2 Shared cost-summary helper (server)

Add `src/model-billing.ts` — a pure module owning the
transform from an `SDKModelInfo` to the client-facing summary.
This is the single owner of the billing-shape knowledge so the
two route sites and any future caller stay consistent
(code-quality.md: avoid the same `?? 1` smell duplicated).

```
export interface ModelCostSummary {
  priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  category?: 'lightweight' | 'versatile' | 'powerful';
  inputPerMtok?: number;   // credits per 1M input tokens
  outputPerMtok?: number;  // credits per 1M output tokens
  cachePerMtok?: number;
  multiplier: number;      // legacy, defaults 1
}

export function modelCostSummary(m: SDKModelInfo): ModelCostSummary;
```

Per-MTOK derivation: when `tokenPrices.batchSize` is present and
nonzero, `inputPerMtok = inputPrice / batchSize * 1_000_000`.
When batchSize is exactly 1,000,000 (all current models) this is
just `inputPrice`. Guard against missing/zero batchSize → leave
the per-MTOK fields undefined. When `billing` or `tokenPrices`
is absent (e.g. `auto`), all price fields are undefined and
`multiplier` is 1.

### 5.3 `/api/models` + `/api/sessions` (additive)

Both map each model through `modelCostSummary` and spread the
result alongside `id`/`name`. Keep `multiplier` (api.ts) and
`cost` (sessions.ts) for back-compat — `cost` stays
`summary.multiplier`. New fields: `priceCategory`, `category`,
`inputPerMtok`, `outputPerMtok`, `cachePerMtok`.

Example `/api/models` item:
```
{ id, name, multiplier: 1, priceCategory: 'high',
  category: 'powerful', inputPerMtok: 500, outputPerMtok: 2500,
  cachePerMtok: 50 }
```

### 5.4 Raw passthrough endpoint for the applet

Add `GET /api/models/raw` returning the untransformed
`sessionManager.getModels()` array (the full SDK `Model`
objects). The `model-info` applet renders these
property-agnostically. This keeps the applet decoupled from any
hand-maintained field list — when the SDK adds properties, they
appear automatically.

Rationale for a separate endpoint (vs extending `/api/models`):
the pickers want a curated, stable summary; the applet wants the
firehose. Two consumers, two shapes. The raw endpoint is
explicitly "whatever the SDK returns" with no contract beyond
"array of objects".

`/api/models/raw` is **session-independent**: it must not
consult `sessionState.activeSessionId` or require a `session`
query param. It reads `sessionManager.getModels()` (the cached
catalog) directly, so the `model-info` applet works with no
session attached.

### 5.5 Client `ModelInfo` type

Extend `public/ts/types.ts`:
```
interface ModelInfo {
  id: string;
  name: string;
  cost: number;                 // legacy multiplier, kept
  priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  category?: 'lightweight' | 'versatile' | 'powerful';
  inputPerMtok?: number;
  outputPerMtok?: number;
  cachePerMtok?: number;
}
```

### 5.6 `/model` slash-command picker (limited real estate)

`command-registry.ts:140-144`: the description becomes the
price category when present, else a graceful fallback:
- `priceCategory` present → that string (`low`/`medium`/`high`/
  `very_high`).
- else if `cost === 0` → `free`.
- else → `''` (no badge; e.g. `auto`).

No numeric MTOK here — the slash popup row is narrow.

### 5.7 New-session picker (more real estate)

`model-selector.ts:72-92`: replace the multiplier badge logic
with:
- If `inputPerMtok` and `outputPerMtok` are present:
  `${inputPerMtok}:${outputPerMtok}/Mtok` (e.g. `300:1500/Mtok`).
  Add a `.model-cost` class plus a tier-derived modifier class
  (`.tier-low/.tier-medium/.tier-high/.tier-very-high`) for
  color, taken from `priceCategory`.
- Else if `cost === 0` → `free`.
- Else → no badge.

The existing `model-cost` CSS keeps working; new tier classes
are added in the stylesheet. Old `premium/ultra/cheap/expensive`
classes can stay or be removed (they're now unreachable since
`cost` is always 1; spec leaves removal to impl discretion as a
cleanup).

### 5.8 `model-info` applet (property-agnostic table)

New `applets/model-info/`:
- `meta.json` — slug `model-info`, name "Model Info",
  description "Inspect all model properties in a table".
- `content.html` — a heading + a `<div id="model-table">`.
- `script.js` — `appletAPI.fetch('/api/models/raw')`, then
  build a table generically:
  - Collect the union of all top-level keys across all model
    objects (stable order: first-seen across models, with `id`
    and `name` forced first).
  - One row per model, one column per key.
  - Cell rendering: primitives shown as-is; objects/arrays shown
    as compact JSON (`JSON.stringify`), truncated with a
    title-attr full value. V1 messy is acceptable.
  - Call `setAppletState({ models })` for observability.
- `style.css` — minimal table styling (borders, sticky header,
  horizontal scroll). Reuse Caco CSS vars.

Flattening nested billing is **not** required for V1 — dumping
`billing` as JSON in one cell satisfies "all properties". A
follow-up can flatten dotted paths (`billing.tokenPrices.inputPrice`)
into columns if the table proves useful.

## 6. Considerations

### 6.1 Why a server-side summary helper

Both route sites do `m.billing?.multiplier ?? 1` today — the
exact duplicated-knowledge smell. Centralizing in
`src/model-billing.ts` means the new (more complex) billing
extraction lives in one tested place. The routes become
`models.map(m => ({ id, name, ...modelCostSummary(m) }))`.

### 6.2 Back-compat

`cost` (sessions) and `multiplier` (models) are preserved and
keep defaulting to 1. Any consumer not updated still works,
just shows no useful cost (same as today). Nothing regresses.

### 6.3 Raw endpoint stability

`/api/models/raw` deliberately has no schema contract. The
applet must tolerate arbitrary shapes (missing keys, new keys,
nested objects). This is the price of property-agnostic; the
applet's generic renderer is the mitigation.

### 6.4 batchSize generality

Hard-coding "inputPrice == per-Mtok" would break if GitHub ships
a model with a different batchSize. The helper divides by
batchSize and scales to 1e6, so it's correct regardless. Prices
are credits *per batch*, so a smaller batch means more credits
per MTOK: `inputPrice 300 / batchSize 500000 * 1e6 = 600/Mtok`.
Tested with batchSize 1e6 (identity → `inputPrice` unchanged)
and a synthetic 500000 (→ doubled).

### 6.5 Per-MTOK number formatting

Values are integers today (100, 300, 500, 1500…). The helper
returns numbers; the UI does string interpolation. If GitHub
ships fractional credits, the new-session badge would show
decimals — acceptable. No rounding in V1.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| SDK `Model` fields differ from observed (beta) | medium | Helper guards every field with optional access + undefined fallbacks; pickers degrade to no-badge |
| `/api/models/raw` leaks something sensitive | low | Model objects are public catalog data (ids, prices, limits); no tokens/secrets |
| New-session badge clutters narrow rows on mobile | medium | `model-cost` already right-aligned + small; tier color is subtle; verify at mobile width in smoke |
| Removing legacy premium/ultra classes breaks a theme | low | Spec leaves removal optional; if removed, grep themes for the classes first |
| Applet table too wide (many columns) | medium | `style.css` horizontal scroll; V1 accepts messiness |
| `auto` model has no billing → undefined everywhere | high (expected) | Every field optional; `/model` shows no badge, new-session shows no badge, applet shows blank cells |

## 8. Acceptance

Backend:
1. `GET /api/models` items include `priceCategory`, `category`,
   `inputPerMtok`, `outputPerMtok`, `cachePerMtok` when the SDK
   provides them; `multiplier` still present (1).
2. `GET /api/sessions` model items include the same additive
   fields; `cost` still present.
3. `GET /api/models/raw` returns the untransformed SDK model
   array.
4. `auto` model: price fields absent/undefined, no errors.
5. `modelCostSummary` unit tests: real-shape sonnet/opus/haiku/
   gpt-5.5 fixtures produce correct per-MTOK + category; `auto`
   (no billing) yields `{ multiplier: 1 }` only; a synthetic
   `{ inputPrice: 300, batchSize: 500000 }` yields
   `inputPerMtok: 600` (price is per-batch, so a smaller batch
   means MORE credits per MTOK); a fractional
   `{ inputPrice: 2.5, batchSize: 1000000 }` yields
   `inputPerMtok: 2.5` unrounded.

`/model` picker:
6. Each model row's description shows its price category
   (`low/medium/high/very_high`); `auto` shows no badge.

New-session picker:
7. Each model shows `IN:OUT/Mtok` (e.g. `300:1500/Mtok`) with a
   tier color class; `auto` shows no badge; a free model (cost 0,
   no prices) shows `free`.

model-info applet:
8. `?applet=model-info` renders a table with one row per model.
9. Columns include all top-level SDK model keys (id, name,
   capabilities, billing, policy, modelPickerCategory,
   modelPickerPriceCategory, …) with `id`/`name` first.
10. Nested objects (capabilities, billing) render as JSON in
    their cell without crashing.
11. Applet works with no session attached (sessionless —
    `/api/models/raw` is session-independent).

Regression:
12. Model selection still works in both pickers.
13. Existing tests pass unchanged.

## 9. Out of scope (parking lot)

- Flattening nested billing into dotted-path columns in the
  applet.
- Long-context tier display in pickers.
- Actual spend / quota-burn calculation from live token usage.
- Per-message cost estimate.
- Sorting/filtering the model-info table.
- Removing the now-unreachable `cost` multiplier field entirely
  (a wider cleanup once nothing reads it).
