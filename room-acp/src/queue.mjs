// Per-thread work queue: one turn in flight per thread; messages that
// arrive mid-turn are batched into the next turn. Threads run in parallel
// up to `concurrency`. A bounded optional reservation keeps discovered
// priority work from waiting behind every recovery slot.
export class ThreadQueue {
  constructor({ run, concurrency = 4, reservedPriority = 0 }) {
    if (!Number.isInteger(reservedPriority) || reservedPriority < 0 || reservedPriority >= concurrency)
      throw Error('Priority reservation must leave at least one recovery slot');
    Object.assign(this, {run, concurrency, reservedPriority});
    this.threads = new Map(); this.active = 0; this.normalActive = 0; this.priorityActive = 0; this.pendingPriorityKey = null;
    this.waiting = []; this.idleWaiters = [];
  }

  reservePriority(slots) {
    if (!Number.isInteger(slots) || slots < 0 || slots >= this.concurrency) throw Error('Priority reservation must leave at least one recovery slot');
    this.reservedPriority = slots;
    if (!slots) {
      const pending = this.threads.get(this.pendingPriorityKey); if (pending) pending.priority = false;
      this.pendingPriorityKey = null;
    }
    this.#drain();
  }

  push(threadKey, item, {priority = false, priorityPosition = null} = {}) {
    let thread = this.threads.get(threadKey);
    if (!thread) { thread = { items: [], busy: false, priority: false }; this.threads.set(threadKey, thread); }
    if (thread.items.some(existing => item.signalId ? existing.signalId === item.signalId : item.messageId && existing.messageId === item.messageId)) return false;
    thread.items.push(item);
    if (priority === true && this.reservedPriority > 0) {
      const pending = this.threads.get(this.pendingPriorityKey);
      const newer = !pending?.priorityPosition || !priorityPosition
        || priorityPosition.createdAt > pending.priorityPosition.createdAt
        || priorityPosition.createdAt === pending.priorityPosition.createdAt
          && Buffer.compare(Buffer.from(priorityPosition.signalId), Buffer.from(pending.priorityPosition.signalId)) > 0;
      if (!pending || this.pendingPriorityKey === threadKey || newer) {
        if (pending && pending !== thread) pending.priority = false;
        thread.priority = true;
        if (pending !== thread || newer) thread.priorityPosition = priorityPosition;
        this.pendingPriorityKey = threadKey;
      }
    }
    if (!thread.busy && !this.waiting.includes(threadKey)) this.waiting.push(threadKey);
    this.#drain();
    return true;
  }

  depth(threadKey) { const thread = this.threads.get(threadKey); return thread ? thread.items.length + (thread.busy ? 1 : 0) : 0; }

  #drain() {
    while (this.active < this.concurrency) {
      // FIFO within each lane. An active same-thread turn is never preempted.
      let index = this.priorityActive < this.reservedPriority
        ? this.waiting.findIndex(key => this.threads.get(key)?.priority === true) : -1;
      if (index < 0 && this.normalActive < this.concurrency - this.reservedPriority)
        index = this.waiting.findIndex(key => this.threads.get(key)?.priority !== true);
      if (index < 0 || index >= this.waiting.length) return;
      const [threadKey] = this.waiting.splice(index, 1), thread = this.threads.get(threadKey);
      const priority = thread.priority; thread.priority = false; thread.busy = true;
      if (priority && this.pendingPriorityKey === threadKey) this.pendingPriorityKey = null;
      this.active++; if (priority) this.priorityActive++; else this.normalActive++;
      const batch = thread.items.splice(0);
      Promise.resolve().then(() => this.run(threadKey, batch)).catch(() => {}).finally(() => {
        thread.busy = false; this.active--; if (priority) this.priorityActive--; else this.normalActive--;
        if (!thread.items.length) this.threads.delete(threadKey);
        else this.waiting.push(threadKey);
        this.#drain();
        if (!this.active && !this.waiting.length) for (const resolve of this.idleWaiters.splice(0)) resolve();
      });
    }
  }

  idle() { return this.active || this.waiting.length ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }
}
