# Code Review: `/session-context-window`

**Reviewer:** Code Review Agent  
**Date:** 2024  
**Scope:** Working-tree diff (unstaged changes)  
**Focus:** Bugs, correctness, security, regressions only

---

## Verdict: **SHIP**

No blocking issues found. The implementation is correct and matches the spec.

---

## Must-Fix Issues

None.

---

## Nice-to-Haves (Non-Blocking)

### 1. Defense-in-depth: Guard against corrupted persisted NaN
**File:** `src/context-budget.ts:53`  
**Current:** `if (!budgetTokens || budgetTokens <= 0) return null;`  
**Why it works now:** `!NaN` evaluates to `true` in JavaScript, so NaN is correctly caught and returns null. The route validation at `sessions.ts:501` with `Number.isFinite(tokens)` prevents writing NaN to meta.  
**Nice-to-have:** Explicit `Number.isFinite(budgetTokens)` check for code clarity and defense against manual meta edits or future persistence bugs. The current behavior is correct but relies on the subtle truthiness of `!NaN`.

```typescript
// Suggested (non-blocking):
if (!budgetTokens || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return null;
```

---

## Detailed Analysis (All Passing)

### 1. Recreate Safety (`setSessionContextBudget`)
✅ **No orphan window:** Between `activeSessions.delete(1161)` and `resume(1164)`, a concurrent PATCH would call `setSessionContextBudget`, which checks `if (!active)` at line 1141 and throws. The second call is rejected cleanly.

✅ **No TOCTOU race:** Route checks `isBusy(495)`, then validates synchronously (500-516), then calls `setSessionContextBudget(518)`. JavaScript's single-threaded execution means no `await` occurs between the check and the call, making them effectively atomic. The first `await` is inside `setSessionContextBudget` at `disconnect(1155)`, by which point meta is already persisted and `dispatchState.end` will be called next.

✅ **Short-circuit correct:** Line 1149 compares `previousBudget === newBudget`. Both are `number | undefined`. When `tokens` is `null` (clear intent), line 1147 normalizes to `undefined`. When `tokens` is a positive number, it's preserved. Comparison is correct for both cases.

✅ **Normalization matches route validation:** Line 1147: `tokens && tokens > 0 ? tokens : undefined`. Route at 500-516 validates `tokens !== null`, then `typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0`. By the time it reaches line 1147, `tokens` is either `null` (→ `undefined`) or a valid positive finite number. Normalization is consistent.

### 2. infiniteSessionsFor Only on Resume
✅ **Correct by design:** Lines 534-537 explain why create skips `infiniteSessions`: a brand-new session has no persisted `sessionId` yet, so `getSessionMeta(sessionId)` can't retrieve a budget. The budget is applied when the user explicitly sets it via `setSessionContextBudget`, which recreates via resume. No path creates a session that should have a budget but doesn't get one.

### 3. thresholdForBudget Math
✅ **NaN handled:** `!NaN` is `true`, so line 53 returns `null` for NaN. Verified with `node` REPL.

✅ **Infinity handled:** `!Infinity` is `false`, but `Infinity <= 0` is also `false`, so it continues to line 56. Then `Infinity / w` produces `Infinity`, and `Infinity >= 0.95` is `true`, so line 57 returns `null`. Correct.

✅ **No off-by-one:** Clamp is `[0.05, 0.94]`. Clear-at-ratio is `0.95`. These never overlap. Test at `context-budget.test.ts:52-58` confirms `T/W in [0.94, 0.95)` clamps to `0.94`, strictly below `bufferExhaustionThreshold (0.95)`.

✅ **Unit tests pass:** All 11 tests in `context-budget.test.ts` pass, covering edge cases (0, negatives, 0.95+, tiny budgets, denominator fallback, prompt-limit priority).

### 4. Denominator & modelTokenLimits
✅ **BYOK models included:** `listByokModels()` returns models with namespaced IDs (`${providerId}:${modelId}`). `aggregateModels()` merges GitHub and BYOK into `cachedModels`. `modelTokenLimits(cacoModelId)` looks up by `id` at line 417, which matches namespaced IDs. Lookup will hit for BYOK.

✅ **Prompt-token precedence:** Line 420: `maxPromptTokens: m.capabilities?.limits?.max_prompt_tokens`. Line 507 (route) uses `limits?.maxPromptTokens ?? limits?.maxContextWindowTokens`, matching the spec's denominator rule and the SDK runtime's choice (`app.js:3644`).

✅ **Client uses contextWindow (approximate):** Command-registry line 246 uses `getAvailableModels().find(m => m.id === model)?.contextWindow`. This is the user-facing picker, which the spec says is "approximate" because the picker can't access prompt-token limits. The server's conversion (lines 506-507) is authoritative and correct.

### 5. Route Validation
✅ **Type safety at runtime:** Line 499 checks `if (tokens !== null)` to distinguish "absent" (undefined, handled by outer `if (contextBudgetTokens !== undefined)` at 494) from "clear" (null, skip validation) from "set" (number, validate). Line 501 checks `typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0`, which catches string/object/boolean/NaN/Infinity/zero/negative. Correct.

✅ **Busy → 409:** Line 495 checks `isBusy` before any mutation. Returns 409 with `SESSION_BUSY` code. Client shows red toast (command-registry.ts:228).

✅ **Tokens > W → 400:** Lines 512-515 compare `tokens > w` and reject with a clear message showing both values.

✅ **W unknown → 400:** Lines 508-510 reject when `w === 0` (no resolvable window).

### 6. Picker (command-registry.ts)
✅ **Snapping + dedup + sort:** Lines 251-262 compute `raw = pct * w`, snap to 100k, fall back to raw if zero, dedup via `Set<number>`, then sort ascending (line 261). Verified with 200k example: 0.2→40k (raw fallback), 0.4→100k, 0.6→100k (deduped), 0.8→200k. Result: `[40k, 100k, 200k]` per spec.

✅ **Red rendering (<100k):** Line 260 sets `danger: effective < 100_000`. CSS at `style.css:285` applies `color: var(--color-error)`. Input-popup.ts:184 adds `danger` class.

✅ **'default' round-trip:** Picker pushes `{ id: 'default', ... }` at line 264. Handler at line 208 checks `trimmed === 'default'` and sets `tokens = null`. Round-trip is correct.

✅ **No 0 or NaN:** Line 254 ensures `effective > 0` via `snapped > 0 ? snapped : Math.round(raw)`. `parseTokenCount` at line 271 rejects `n <= 0` and `!Number.isFinite(n)`. No path produces 0 or NaN.

### 7. Toast/UX
✅ **Success replay message:** Line 225: `Context capped at ${formatTokenCount(tokens)} — history replays once`. Matches spec intent to inform user of one-time cost.

✅ **Clear message:** Line 223: `Context cap cleared (SDK default ~80%)`. Accurate.

✅ **Failure with server msg:** Line 228: `data.error || 'Failed to set context window'`. Catches route errors (busy, invalid, exceeds window).

✅ **parseTokenCount rejects junk:** Regex at line 269: `/^(\d+(?:\.\d+)?)\s*([km])?$/i`. Rejects non-numeric, multiple units, or empty. Returns `null` on failure, which triggers red toast at line 212.

---

## Spec Compliance

All spec-mandated behaviors implemented:
- ✅ Busy-session guard (409 rejection)
- ✅ Picker with snapping, dedup, red <100k, sort
- ✅ Flat arg with k/m suffixes
- ✅ 'default'/'reset'/'full' → clear
- ✅ Recreate safety with rollback on failure
- ✅ infiniteSessions only on resume (by design)
- ✅ T/W ≥ 0.95 → clear override
- ✅ [0.05, 0.94] clamp, strictly below bufferExhaustionThreshold
- ✅ Denominator: max_prompt_tokens ?? max_context_window_tokens
- ✅ /api/sessions/:id/state returns contextBudgetTokens
- ✅ README.md updated with command

---

## Code Quality (per `code-quality.md`)

**Strong typing:** ✅ Route validates runtime types; pure functions use explicit types.  
**Correct by design:** ✅ Short-circuit avoids needless recreate; rollback restores on failure.  
**No implicit coupling:** ✅ Budget stored as absolute token count; conversion happens at apply-time with explicit limits lookup.  
**Minimal code:** ✅ Reuses `setSessionModel` recreate pattern; picker logic is ~60 lines for full UX.  
**Enforced valid classes:** ✅ `thresholdForBudget` returns `null` for invalid inputs rather than throwing or returning garbage.

---

## Summary

Implementation is correct, well-tested, and matches the spec. The busy guard is sufficient (no TOCTOU due to single-threaded execution), NaN/Infinity are handled correctly (contrary to initial inspection), BYOK models are included in the lookup, and all edge cases have tests or runtime guards. The only nice-to-have is an explicit `Number.isFinite` check in `thresholdForBudget` for defense-in-depth, but the current code already handles NaN correctly via `!NaN === true`.

**Recommendation:** Ship as-is. The nice-to-have can be addressed in a follow-up if desired for code clarity.
