# Spec: transient turn retry

## Goals

After sleep or power-on the network is often not up yet. The SDK then fails the
turn before the model runs, for example:

> Execution failed: Unable to discover model capabilities for '...'. ... Check
> authentication and connectivity, then retry: GenericFailure,
> {"kind":"network","message":"Model catalog request timed out"}

The user saw a red `Error:` in the chat and the turn was simply over. Wakes that
hit it recorded a failure. Caco should retry these on its own.

## Design

`src/transient-retry.ts` (pure policy) plus `dispatchMessage` in
`src/routes/session-messages.ts`.

- **When.** A `session.error` arrives during a dispatch, no model output was seen
  in that dispatch (`isModelOutputEvent`: any `tool.*` or `assistant.*` except
  `turn_start`, `turn_end`, `usage`), and the message looks like a connectivity
  failure (`isTransientTurnError`: network, timed out, timeout, connectivity,
  ECONN*, ENOTFOUND, EAI_AGAIN, fetch failed, 502/503/504). The message is only
  classified, never logged.
- **How.** The dispatch tears down as usual (session no longer busy), shows
  `Network not ready. Retrying in Ns (attempt k of 6)` as a `session.info`, and
  schedules a retry: 15s, 30s, 1m, 2m, 4m, 8m, each +/-20% jitter (about 16 min
  in all). The user's message is already in the transcript (the SDK records it
  before failing), so the retry sends
  `[system:retry] The previous turn failed before you responded because the network was not ready. Continue with the previous request.`
  rather than resending it.
- **Same turn.** The retry inherits the failed dispatch's `humanRooted`
  (comms guard), observation policy, offer baseline and depth, exactly like an
  auto-continuation. While a retry is pending no turn outcome is emitted, so a
  running wake or slug run settles once, at the end of the chain.
- **Cancel.** Any other dispatch to the session cancels a pending retry (the new
  turn settles the wake by session). Stop (`POST /cancel`) on an idle session with
  a pending retry cancels it and emits `cancelled`. A retry that fires while the
  session is busy does nothing.
- **Give up.** After 6 attempts, or a non-network error, or a failure after
  output, the error ends the turn as before.

## Invariants

1. A retry never resends the user's prompt.
2. A turn whose model produced any output is never retried.
3. At most one pending retry per session.
4. A retry keeps the original turn's root, so an unattended turn cannot become
   human-rooted by retrying.

## Not covered

Failures before the SDK accepted the send (session resume or client health
check throwing) still surface as an error. They are rarer, and the prompt was
never recorded, so the user can just resend. Wakes cover themselves with their
own backoff (`docs/spec-session-wake.md`).

## Acceptance

| behavior | test |
|---|---|
| Network error before output: info event, no outcome, retry sends `[system:retry]` | `session-messages-route-harness.test.ts` |
| Error after output: not retried, error outcome | same |
| Non-network error: not retried | same |
| Classifier, backoff with jitter, one pending retry per session, cancel | `transient-retry.test.ts` |

## Plan

| phase | scope | status |
|---|---|---|
| 1 | `src/transient-retry.ts` policy; retry chain in `dispatchMessage`; Stop cancels a pending retry; tests | done |
| 2 | Wake backoff and `wake retry` badge (`docs/spec-session-wake.md`) | done |
