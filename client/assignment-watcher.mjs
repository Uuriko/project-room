import { nextWorkStep } from "../src/workflow.js";
import { validId, EVENT_TYPES } from "../src/events.js";
import { WatchError, MAX_ATTENTION } from "./watch-journal.mjs";

export function attentionNotices(snapshot, now = Date.now()) {
  const notices = new Map();
  const items = snapshot.state.workItems;
  if (!items || typeof items !== "object" || Array.isArray(items)) throw new WatchError("invalid_snapshot");
  for (const [id, item] of Object.entries(items)) {
    if (!item || !validId(item.id) || id !== item.id || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.title !== "string") throw new WatchError("invalid_snapshot");
    const next = nextWorkStep(item, now);
    if (!next.needsAttention || next.memberId !== snapshot.viewerId) continue;
    const signature = JSON.stringify([next.action, next.memberId, next.completionEventId, next.evidenceVersion,
      item.blocker?.eventId ?? null, item.decision?.eventId ?? null,
      next.action === "claim" ? [item.claim?.holderId, item.claim?.acquiredAt, item.claim?.expiresAt, item.claim?.status] : null]);
    notices.set(item.id, { signature, payload: { roomId: snapshot.roomId, memberId: snapshot.viewerId, workItemId: item.id,
      title: item.title, next, notifyOnly: true, message: "Needs your attention. Check current scope before acting." } });
    if (notices.size > MAX_ATTENTION) throw new WatchError("attention_capacity");
  }
  return notices;
}

// Snapshot observer, not an event replay or a work executor. State is authoritative
// as of each snapshot; intermediate changes between polls may intentionally be quiet.
export class AssignmentWatcher {
  #running = null;
  constructor({ client, journal, origin, roomId, emit, signal, now = Date.now }) {
    Object.assign(this, { client, journal, origin, roomId, emit, signal, now });
  }
  #active() {
    if (this.signal?.aborted || this.journal.shouldStop()) throw new WatchError("stopped");
  }
  async #anchor(sequence) {
    const page = await this.client.changes(sequence - 1, 1, { signal: this.signal });
    this.#active();
    const row = page?.events?.[0];
    if (page?.events?.length !== 1 || page.next !== sequence || row.sequence !== sequence
        || !validId(row.event?.id) || row.event.roomId !== this.roomId) throw new WatchError("history_changed");
    return row.event;
  }
  async reconcile() {
    this.#active();
    const snapshot = await this.client.snapshot({ signal: this.signal });
    this.#active();
    const member = snapshot?.state?.members?.[snapshot.viewerId];
    if (snapshot?.roomId !== this.roomId || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1
        || !validId(snapshot.viewerId) || member?.id !== snapshot.viewerId || member.active === false
        || (snapshot.viewerAccountId !== null && !validId(snapshot.viewerAccountId))
        || (snapshot.viewerAccountId === null ? snapshot.viewerAuthEpoch !== null
          : !Number.isSafeInteger(snapshot.viewerAuthEpoch) || snapshot.viewerAuthEpoch < 0)
        || !snapshot.state.workItems || !Array.isArray(snapshot.state.eventLog)) throw new WatchError("invalid_snapshot");
    const lastEvent = snapshot.state.eventLog.at(-1);
    if (!validId(lastEvent?.id) || lastEvent.roomId !== this.roomId) throw new WatchError("invalid_snapshot");
    const created = await this.#anchor(1);
    if (created.type !== EVENT_TYPES.ROOM_CREATED) throw new WatchError("history_changed");
    const binding = { version: 1, filter: "own-attention-v1", origin: this.origin, roomId: this.roomId,
      memberId: snapshot.viewerId, accountId: snapshot.viewerAccountId ?? null,
      authEpoch: snapshot.viewerAuthEpoch ?? null, createdEventId: created.id };
    const previous = this.journal.state();
    if (previous) {
      if (JSON.stringify(binding) !== JSON.stringify(previous.binding)) throw new WatchError("identity_changed");
      if (snapshot.sequence < previous.sequence || (await this.#anchor(previous.sequence)).id !== previous.eventId) throw new WatchError("history_changed");
    }
    // Tie the snapshot's last event to its claimed sequence, including first use.
    if ((await this.#anchor(snapshot.sequence)).id !== lastEvent.id) throw new WatchError("history_changed");
    this.#active();
    const now = this.now();
    this.journal.reconcile(binding, { sequence: snapshot.sequence, eventId: lastEvent.id }, attentionNotices(snapshot, now), now);
  }
  tick() {
    if (!this.#running) this.#running = this.#tick().finally(() => { this.#running = null; });
    return this.#running;
  }
  async #tick() {
    await this.reconcile();
    if (!this.journal.pending(1).length) return 0;
    // Re-authenticate and suppress obsolete queued work before each bounded drain.
    await this.reconcile();
    let written = 0;
    for (const notice of this.journal.pending(20)) {
      this.#active();
      await this.emit(notice, this.signal);
      this.#active();
      this.journal.ack(notice.id); written++;
    }
    return written;
  }
}
