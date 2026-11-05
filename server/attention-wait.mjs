import {isCurrentRoom, readCurrentRecord, readCurrentWorkItem, withCurrentReadContext} from './current-room-repository.mjs';
import {ServiceError} from './service-error.mjs';
import {nextWorkStep} from '../src/workflow.js';

// Only resource accounting lives here. Attention and delivery cursors remain in
// the existing protected inbox; a process restart never acknowledges anything.
const pending = new WeakMap();
const MAX_PROBES = 4;
const MAX_PENDING = 32;
// Events that can leave a task waiting on its next member. Opt-in only, so a
// receiver built before work pointers never sees an unknown item kind.
const WORK_EVENT_TYPES = ['work.proposed', 'work.accepted', 'work.started', 'work.blocked', 'work.blocker_resolved',
  'work.completed', 'work.handoff_recorded', 'work.halt_cleared', 'verification.recorded', 'owner.decision_recorded'];
const MAX_WORK_WINDOWS = 8;
const MAX_WORK_CANDIDATES = 32;

// Work in (from, through] whose current next step waits on this member. The
// event log scans 16 rows per window; a longer gap returns a lower `through`
// so nothing in between is skipped by the caller's next cursor.
function workAttention(store, secret, roomId, memberId, from, through) {
  const ids = new Map();
  let scanned = from;
  for (let windows = 0; scanned < through && windows < MAX_WORK_WINDOWS; windows++) {
    const page = store.eventsAfter(secret, roomId, scanned, 16, null, {types: WORK_EVENT_TYPES, throughSequence: through});
    for (const {sequence, event} of page.events) {
      const id = event.data?.workItemId;
      if (typeof id === 'string' && event.actorId !== memberId) ids.set(id, sequence);
    }
    if (!(page.next > scanned)) break;
    scanned = page.next;
  }
  if (!ids.size) return {through: scanned, items: []};
  // Each candidate is read in its own bounded context, oldest event first, so
  // many small proposals cannot exhaust one shared read budget (409). Stop at
  // four pointers or MAX_WORK_CANDIDATES examined, holding the cursor at the
  // last examined event so the rest are read on the next wait.
  const ownerId = store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => readCurrentRecord(store.db, roomId, 'metadata', 'room', b)?.ownerId ?? null));
  const now = store.now(), items = [], ordered = [...ids].sort((a, b) => a[1] - b[1]);
  let examined = 0;
  for (const [workItemId, sequence] of ordered) {
    if (items.length >= 4 || examined >= MAX_WORK_CANDIDATES) { scanned = Math.min(scanned, ordered[examined - 1][1]); break; }
    examined++;
    const item = store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => readCurrentWorkItem(store.db, roomId, workItemId, b)));
    const next = item ? nextWorkStep(item, now, ownerId) : null;
    if (next?.needsAttention && next.memberId === memberId) items.push({kind: 'work', workItemId, workRevision: item.revision, sequence,
      nextRead: {tool: 'room_read_work', arguments: {roomId, workItemId}}});
  }
  return {through: scanned, items};
}

export function waitForAttention(store, secret, roomId, {after, timeoutSec = 25, includeWork = false, signal} = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 120 || typeof includeWork !== 'boolean') {
    throw new ServiceError(422, 'invalid_attention_wait', 'after must be a nonnegative integer, timeoutSec an integer from 0 to 120 and includeWork a boolean');
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
  if (!active) pending.set(store, active = new Map());
  const key = JSON.stringify([roomId, memberId]);
  const previous = active.get(key);
  if (!previous && active.size >= MAX_PENDING) {
    throw new ServiceError(429, 'attention_wait_busy', 'At most 32 pending waits per server are allowed');
  }
  // Superseding only rejects the old request; never run its protected probe in
  // the replacement request's OAuth context. Each slot has its own generation.
  previous?.supersede?.();
  const generation = {};
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let done = false, wakeResolve, wakePending = false, probes = 0, cursor = after, timer, unsubscribe;
    const clean = () => {
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', cancelled);
      if (active.get(key) === generation) active.delete(key);
      wakeResolve?.();
    };
    const fail = error => { if (!done) { done = true; clean(); reject(error); } };
    generation.supersede = () => fail(new ServiceError(409, 'attention_wait_superseded', 'A newer wait for this room member replaced this request; use the newer request result'));
    active.set(key, generation); // Supersede is initialized before this slot is visible.
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
        const from = cursor, work = includeWork ? workAttention(store, secret, roomId, memberId, from, page.cursor.after) : null;
        // A capped work scan holds the cursor back; messages past it return on the next wait.
        const capped = work !== null && work.through < page.cursor.after;
        cursor = capped ? work.through : page.cursor.after;
        const seen = new Set(), items = [];
        for (const [kind, rows] of [['direct_message', page.directMessages], ['reply', page.replies], ['mention', page.directMentions]]) {
          for (const row of rows) {
            if (row.sequence <= after || row.sequence > cursor || seen.has(row.messageId)) continue;
            seen.add(row.messageId);
            items.push({kind: row.requestKind === 'reply' ? 'reply_request' : kind,
              messageId: row.messageId, sequence: row.sequence,
              nextRead: row.nextRead ?? {tool: 'room_read_inbox', arguments: {roomId, after: row.sequence - 1, limit: 1}}});
          }
        }
        let overflow = false;
        if (work) {
          for (const item of work.items) if (item.sequence > after) items.push(item);
          items.sort((a, b) => a.sequence - b.sequence);
          // Four pointers per result; an overflow resumes right after the fourth.
          if ((overflow = items.length > 4)) { cursor = items[3].sequence; items.length = 4; }
        }
        if (items.length) finish('ready', items, !page.cursor.hasMore && !capped && !overflow);
        else if (page.cursor.hasMore || capped || probes >= MAX_PROBES) finish('catch_up_required', [], !page.cursor.hasMore && !capped);
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
    try {
    unsubscribe = store.onEventAppended(changedRoom => {
      if (done || changedRoom !== roomId) return;
      wakePending = true;
      wakeResolve?.();
    });
    signal?.addEventListener('abort', cancelled, {once: true});
    timer = setTimeout(() => { try { if (!done) finish('timeout'); } catch (error) { fail(error); } }, timeoutSec * 1000);
    void pump();
    if (signal?.aborted) cancelled(); else probe();
    } catch (error) { fail(error); }
  });
}
