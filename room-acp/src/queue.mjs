// Per-thread work queue: one turn in flight per thread; messages that
// arrive mid-turn are batched into the next turn. Threads run in parallel
// up to `concurrency`.
export class ThreadQueue {
  constructor({ run, concurrency = 4 }) { this.run = run; this.concurrency = concurrency; this.threads = new Map(); this.active = 0; this.waiting = []; this.idleWaiters = []; }

  push(threadKey, item) {
    let thread = this.threads.get(threadKey);
    if (!thread) { thread = { items: [], busy: false }; this.threads.set(threadKey, thread); }
    if (thread.items.some(existing => existing.messageId === item.messageId)) return false;
    thread.items.push(item);
    this.#schedule(threadKey);
    return true;
  }

  depth(threadKey) { const thread = this.threads.get(threadKey); return thread ? thread.items.length + (thread.busy ? 1 : 0) : 0; }

  #schedule(threadKey) {
    const thread = this.threads.get(threadKey);
    if (!thread || thread.busy || !thread.items.length) return;
    if (this.active >= this.concurrency) { if (!this.waiting.includes(threadKey)) this.waiting.push(threadKey); return; }
    thread.busy = true; this.active++;
    const batch = thread.items.splice(0);
    Promise.resolve().then(() => this.run(threadKey, batch)).catch(() => {}).finally(() => {
      thread.busy = false; this.active--;
      if (!thread.items.length) this.threads.delete(threadKey);
      else this.#schedule(threadKey);
      const next = this.waiting.shift();
      if (next) this.#schedule(next);
      if (!this.active) for (const resolve of this.idleWaiters.splice(0)) resolve();
    });
  }

  idle() { return this.active ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }
}
