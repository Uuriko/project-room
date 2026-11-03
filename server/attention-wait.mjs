import {isCurrentRoom} from './current-room-repository.mjs';
import {ServiceError} from './service-error.mjs';

// Only resource accounting lives here. Attention and delivery cursors remain in
// the existing protected inbox; a process restart never acknowledges anything.
const pending = new WeakMap();
const MAX_PROBES = 4;
const MAX_PENDING = 32;

export function waitForAttention(store, secret, roomId, {after, timeoutSec = 25, signal} = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 120) {
    throw new ServiceError(422, 'invalid_attention_wait', 'after must be a nonnegative integer and timeoutSec an integer from 0 to 120');
  }
  const auth = store.authenticate(secret, roomId);
  const memberId = auth.member.id;
  const requireSameMember = () => {
    if (store.authenticate(secret, roomId).member.id !== memberId) {
      throw new ServiceError(409, 'attention_wait_binding_changed', 'The selected room member changed; check access and start a new wait with the current inbox cursor');
    }
  };
  if (!isCurrentRoom(store.db, roomId)) {
    throw new ServiceError(409, 'attention_wait_unavailable', 'Bounded attention waiting requires a normalized room; use room_read_inbox');
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
  let active = pending.get(store);
  if (!active) pending.set(store, active = new Set());
  const key = JSON.stringify([roomId, memberId]);
  if (active.has(key) || active.size >= MAX_PENDING) {
    throw new ServiceError(429, 'attention_wait_busy', 'At most one pending wait per member and room, and 32 per server, is allowed');
  }
  active.add(key);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let done = false, wakeResolve, wakePending = false, probes = 0, cursor = after;
    const clean = () => {
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', cancelled);
      active.delete(key);
      wakeResolve?.();
    };
    const fail = error => { if (!done) { done = true; clean(); reject(error); } };
    const cancelled = () => fail(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
    const finish = (status, items = [], sourceComplete = true) => {
      // Access can expire or be revoked while no event is appended.
      requireSameMember();
      done = true;
      clean();
      resolve({roomId, memberId, status, items, after: cursor,
        sourceComplete, globalAttentionComplete: false, acknowledges: false,
        timeoutSec, waitedMs: Math.max(0, Date.now() - started),
        nextRead: {tool: 'room_read_inbox', arguments: {roomId, after: cursor, limit: 4}}});
    };
    const probe = () => {
      if (done) return;
      try {
        requireSameMember();
        probes++;
        const page = store.agentInbox(secret, roomId, {after: cursor, limit: 4});
        cursor = page.cursor.after;
        const seen = new Set(), items = [];
        for (const [kind, rows] of [['direct_message', page.directMessages], ['reply', page.replies], ['mention', page.directMentions]]) {
          for (const row of rows) {
            if (row.sequence <= after || seen.has(row.messageId)) continue;
            seen.add(row.messageId);
            items.push({kind: row.requestKind === 'reply' ? 'reply_request' : kind,
              messageId: row.messageId, sequence: row.sequence,
              nextRead: row.nextRead ?? {tool: 'room_read_inbox', arguments: {roomId, after: row.sequence - 1, limit: 1}}});
          }
        }
        if (items.length) finish('ready', items, !page.cursor.hasMore);
        else if (page.cursor.hasMore || probes >= MAX_PROBES) finish('catch_up_required', [], !page.cursor.hasMore);
        else if (timeoutSec === 0) finish('timeout');
      } catch (error) { fail(error); }
    };
    // The await continuation belongs to this request's OAuth/auth context,
    // rather than to the unrelated writer that invokes the commit listener.
    const pump = async () => {
      while (!done) {
        await new Promise(resolve => { wakeResolve = resolve; if (wakePending) resolve(); });
        wakeResolve = null;
        wakePending = false;
        if (!done) probe();
      }
    };
    // Subscribe before the first probe so an append cannot fall into a gap.
    const unsubscribe = store.onEventAppended(changedRoom => {
      if (done || changedRoom !== roomId) return;
      wakePending = true;
      wakeResolve?.();
    });
    signal?.addEventListener('abort', cancelled, {once: true});
    const timer = setTimeout(() => { try { if (!done) finish('timeout'); } catch (error) { fail(error); } }, timeoutSec * 1000);
    void pump();
    probe();
  });
}
