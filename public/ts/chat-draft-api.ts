/**
 * Chat-draft persistence API client.
 *
 * Per-key serialized read/write/delete for the chat input textarea
 * draft. See docs/spec-chat-form.md.
 *
 * The per-key queue is mandatory: it guarantees DELETE issued on the
 * send path always observes any in-flight PUT from the debounce timer
 * — without it, a PUT mid-flight could land AFTER the DELETE and
 * resurrect a draft of the just-sent message.
 */

const NEWCHAT_KEY = '__newchat__';

function keyFor(sessionId: string | null): string {
  return sessionId ?? NEWCHAT_KEY;
}

function urlFor(sessionId: string | null): string {
  return sessionId === null
    ? '/api/draft/newchat'
    : `/api/sessions/${encodeURIComponent(sessionId)}/draft`;
}

/** Per-key serialization queue. Map<key, lastPromise>. Each enqueue
 *  chains onto the prior promise so requests for the same key run in
 *  order, regardless of network timing. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionId: string | null, op: () => Promise<T>): Promise<T> {
  const key = keyFor(sessionId);
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.then(op, op);  // run even if prior rejected
  queues.set(key, next);
  // Clean the slot once the chain settles, but only if it's still
  // the latest — avoids leaking entries for never-touched-again
  // sessions while not racing in-flight follow-ups.
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => {});
  return next;
}

/** GET the draft. Returns the body text, or null on 404, or null on
 *  network/parse error. */
export function getDraft(sessionId: string | null): Promise<string | null> {
  return enqueue(sessionId, async () => {
    try {
      const res = await fetch(urlFor(sessionId), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) {
        console.warn('[chat-draft] GET failed', res.status);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.warn('[chat-draft] GET error', err);
      return null;
    }
  });
}

/** PUT the draft. Returns true on success, false on 4xx/5xx/error.
 *  Body cap (413) is enforced by the server; callers should also
 *  skip the PUT when the local text exceeds 1 MiB to avoid the
 *  round-trip. */
export function putDraft(sessionId: string | null, text: string): Promise<boolean> {
  return enqueue(sessionId, async () => {
    try {
      const res = await fetch(urlFor(sessionId), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: text,
      });
      if (res.ok || res.status === 204) return true;
      console.warn('[chat-draft] PUT failed', res.status);
      return false;
    } catch (err) {
      console.warn('[chat-draft] PUT error', err);
      return false;
    }
  });
}

/** DELETE the draft. Returns true on success or already-absent. */
export function deleteDraft(sessionId: string | null): Promise<boolean> {
  return enqueue(sessionId, async () => {
    try {
      const res = await fetch(urlFor(sessionId), { method: 'DELETE' });
      return res.ok || res.status === 204 || res.status === 404;
    } catch (err) {
      console.warn('[chat-draft] DELETE error', err);
      return false;
    }
  });
}

/** Test-only hook to clear the queue map between tests. */
export function _resetDraftQueueForTests(): void {
  queues.clear();
}
