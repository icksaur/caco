/**
 * Typed form-state store for the chat-input form.
 *
 * Replaces the synthetic-`input`-event signalling pattern that
 * caused the chat-draft bleed bug (docs/archive/chat-draft-postmortem.md).
 * Callers that want to refresh the form's send/stop/options UI
 * push a typed update via `formStateStore.set({...})`; the
 * `updateButton` subscriber re-runs in response.
 *
 * Singleton scope: chatting view only. New-chat view has no busy
 * state or response options; its form is independent. See
 * docs/chat-form-refactor.md §"Per-form store vs singleton store".
 */

export interface FormState {
  options: readonly string[];   // response option buttons
  sessionBusy: boolean;          // active chatting session is mid-dispatch
  hasText: boolean;              // textarea is non-empty (trimmed)
}

interface Internal {
  state: FormState;
  subscribers: Set<(s: FormState) => void>;
}

const internal: Internal = {
  state: {
    options: Object.freeze([] as string[]) as readonly string[],
    sessionBusy: false,
    hasText: false,
  },
  subscribers: new Set(),
};

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const formStateStore = {
  /** Current state. Returned object is shared; the `options` array
   *  inside is frozen so subscribers cannot mutate it in place. */
  get(): FormState {
    return internal.state;
  },

  /** Shallow-merge updates into the current state. No-op if every
   *  partial field equals its current value (prevents subscriber
   *  notification spam on idempotent sets). `options` mutations are
   *  detected by element-wise compare and frozen on store. */
  set(partial: Partial<FormState>): void {
    let changed = false;
    let next = internal.state;
    for (const key of Object.keys(partial) as (keyof FormState)[]) {
      if (key === 'options') {
        const incoming = partial.options!;
        if (!arraysEqual(next.options, incoming)) {
          next = {
            ...next,
            options: Object.freeze(incoming.slice()) as readonly string[],
          };
          changed = true;
        }
      } else if (next[key] !== (partial as FormState)[key]) {
        next = { ...next, [key]: (partial as FormState)[key] };
        changed = true;
      }
    }
    if (!changed) return;
    internal.state = next;
    for (const fn of internal.subscribers) fn(internal.state);
  },

  /** Register a subscriber. Returns a dispose function. */
  subscribe(fn: (s: FormState) => void): () => void {
    internal.subscribers.add(fn);
    return () => { internal.subscribers.delete(fn); };
  },
};

/** Test-only: reset state and clear subscribers between tests. */
export function _resetFormStateForTests(): void {
  internal.state = {
    options: Object.freeze([] as string[]) as readonly string[],
    sessionBusy: false,
    hasText: false,
  };
  internal.subscribers.clear();
}
