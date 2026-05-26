/**
 * Panel State Store
 *
 * Single source of truth for top-level panel visibility (#sessionView and
 * #appletPanel). All writers go through `set()`; the DOM binder subscribes
 * and reflects state into class names. No async, no DOM, no fetch in this
 * module — pure data so it's unit-testable.
 *
 * See docs/panel-state-architecture.md (in panel-state-architecture.md at
 * repo root during the refactor) for rationale.
 */

export interface PanelState {
  /** #sessionView visible */
  session: boolean;
  /** #appletPanel visible */
  applet: boolean;
}

/**
 * Why a transition happened. Recorded for debugging and propagated to
 * subscribers so they can route persistence / telemetry.
 */
export type Reason =
  | 'init'                    // bootstrap from initial DOM state
  | 'user-toggle-session'     // tap #menuBtn
  | 'user-toggle-applet'      // tap #appletBtn
  | 'user-session-pick'       // tap a session in the list (mobile dismiss)
  | 'deep-link';              // page load with ?applet=... in URL

export type Subscriber = (next: PanelState, prev: PanelState, reason: Reason) => void;

export interface PanelStateStore {
  get(): Readonly<PanelState>;
  set(patch: Partial<PanelState>, reason: Reason): void;
  subscribe(fn: Subscriber): () => void;
}

export function createPanelStateStore(initial: PanelState): PanelStateStore {
  let current: PanelState = { ...initial };
  const subscribers = new Set<Subscriber>();

  return {
    get() {
      return current;
    },
    set(patch, reason) {
      const next: PanelState = { ...current, ...patch };
      if (next.session === current.session && next.applet === current.applet) {
        return; // no-op; don't fire subscribers
      }
      const prev = current;
      current = next;
      for (const fn of subscribers) {
        try { fn(next, prev, reason); } catch (e) {
          console.error('[panel-state] subscriber threw:', e);
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

export type DeviceClass = 'mobile' | 'desktop';

/**
 * Single device-class decision point. Mobile breakpoint matches style.css.
 * Returns 'desktop' in non-browser environments (unit tests).
 */
export function deviceClass(): DeviceClass {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'desktop';
  }
  return window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
}

/**
 * Module-level singleton. Lazy so tests can construct their own store.
 */
let _singleton: PanelStateStore | null = null;

export function getPanelState(): PanelStateStore {
  if (!_singleton) {
    _singleton = createPanelStateStore({ session: false, applet: false });
  }
  return _singleton;
}

export function setPanelStateForTest(store: PanelStateStore | null): void {
  _singleton = store;
}
