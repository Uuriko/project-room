// The bridge loop: lease the room's wake queue, long-poll for mentions,
// run each thread's turn on the local ACP agent, post the reply in the
// thread, then ack the wakes. Wakes are acked only after the reply posts,
// so a crash before posting means the Room re-delivers them.
import { RoomClient, RoomError } from "./room.mjs";
import { AgentHost } from "./agent-host.mjs";
import { ThreadQueue } from "./queue.mjs";
import { buildPrompt } from "./prompt.mjs";
import { renderTurn } from "./render.mjs";
import { SessionMap } from "./sessions.mjs";
import { PermissionBroker, decisionOf, DEFAULT_PERMISSION_TIMEOUT_MS } from "./permission.mjs";

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60 * 1000;

const sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

export function mayTalk({ authorId, members, me, ownerId, respondTo }) {
  if (!authorId || authorId === me?.id) return false;
  if (respondTo === "anyone") return Boolean(members[authorId] && members[authorId].active !== false);
  const boss = me?.accountableHumanId ?? ownerId;
  if (authorId === boss) return true;
  const author = members[authorId];
  return Boolean(author && author.kind === "agent" && author.active !== false && author.accountableHumanId === boss);
}

export class Bridge {
  constructor({ connection, candidate, cwd, env, mode = null, respondTo = "anyone", maxSessions = 4, waitMs = 25000, cadenceSeconds = 30, fetchImpl = fetch, log = () => {}, host = null, persistSessions = true, restartDelayMs = 1000, minPollIntervalMs = 2500, permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS, permissionPollMs = 1500 }) {
    this.connection = connection; this.respondTo = respondTo; this.waitMs = waitMs; this.cadenceSeconds = cadenceSeconds; this.log = log;
    this.room = new RoomClient({ apiBase: connection.apiBase, roomId: connection.roomId, memberId: connection.memberId, credential: connection.credential, fetchImpl });
    this.sessionMap = new SessionMap({ roomId: connection.roomId, hostId: connection.hostId, env, persist: persistSessions });
    this.host = host ?? new AgentHost({ candidate, cwd, env, mode, log, savedSessions: this.sessionMap, onPermission: request => this.onPermission(request) });
    this.permissionTimeoutMs = permissionTimeoutMs; this.permissionPollMs = permissionPollMs;
    this.restartDelayMs = restartDelayMs; this.minPollIntervalMs = minPollIntervalMs; this.lastPollAt = 0; this.crashes = []; this.pausedUntil = 0; this.ready = null;
    this.queue = new ThreadQueue({ concurrency: maxSessions, run: (threadKey, batch) => this.turn(threadKey, batch) });
    this.host.onExit?.(info => this.onAgentExit(info));
    this.fencingToken = null; this.seen = new Set(); this.controller = new AbortController(); this.stats = { turns: 0, posted: 0, acked: 0, skipped: 0 };
  }

  // Agent process died: restart with backoff; CRASH_LIMIT crashes inside
  // CRASH_WINDOW_MS pause the bridge for a window. Wakes stay queued.
  onAgentExit(info) {
    if (this.controller.signal.aborted) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter(at => now - at < CRASH_WINDOW_MS), now];
    const paused = this.crashes.length >= CRASH_LIMIT;
    const delay = paused ? CRASH_WINDOW_MS : this.restartDelayMs * 2 ** (this.crashes.length - 1);
    if (paused) { this.pausedUntil = now + delay; this.crashes = []; this.log(`agent crashed ${CRASH_LIMIT} times in 5 minutes; pausing for 5 minutes`); }
    else this.log(`agent exited (code ${info.code ?? info.signal}); restarting in ${Math.round(delay / 1000)}s`);
    this.ready = sleep(delay, this.controller.signal).then(() => (this.controller.signal.aborted ? null : this.host.start()))
      .then(() => { this.pausedUntil = 0; }, error => { this.log(`agent restart failed: ${error.message}`); this.onAgentExit({ code: "start-failed" }); });
  }

  async agentReady() {
    while (!this.host.running && this.ready && !this.controller.signal.aborted) await this.ready;
  }

  // Tool permission asks go to the agent's accountable human in the thread.
  async onPermission(request) {
    if (!this.permissions) return { outcome: { outcome: "cancelled" } };
    return this.permissions.request(request, this.controller.signal);
  }

  async refreshRoom() {
    const value = await this.room.room();
    this.members = value?.state?.members ?? {};
    this.ownerId = value?.state?.room?.ownerId ?? null;
    this.title = value?.state?.room?.title ?? this.connection.roomId;
    this.me = this.members[this.connection.memberId] ?? { id: this.connection.memberId };
    this.permissions ??= new PermissionBroker({ room: this.room, approverId: this.me.accountableHumanId ?? this.ownerId, timeoutMs: this.permissionTimeoutMs, pollMs: this.permissionPollMs, log: this.log });
  }

  async lease() {
    // Renew the listener lease only when it is close to expiry: heartbeats
    // are rate limited, polls are the cheap call.
    if (this.fencingToken && Date.now() < this.leaseRenewAt) return true;
    const value = await this.room.heartbeat({ hostId: this.connection.hostId, cadenceSeconds: this.cadenceSeconds });
    this.fencingToken = value?.listener?.acquired ? value.listener.fencingToken : null;
    const expires = Number(value?.listener?.leaseExpiresAt);
    this.leaseRenewAt = Math.min(Date.now() + this.cadenceSeconds * 1000 / 2, Number.isFinite(expires) ? expires - 20000 : Infinity);
    if (!this.fencingToken) this.log(`another room-acp listener holds this room's wake queue (${value?.listener?.activeListenerId ?? "unknown"}); waiting`);
    return Boolean(this.fencingToken);
  }

  async ack(signalIds) {
    if (!signalIds.length) return;
    await this.room.ack({ signalIds, fencingToken: this.fencingToken });
    this.stats.acked += signalIds.length;
  }

  async threadRoot(messageId) {
    let current = (await this.room.thread(messageId)).thread;
    for (let hops = 0; current.replyToId && hops < 5; hops++) current = (await this.room.thread(current.replyToId)).thread;
    return current;
  }

  // Route one wake signal into the queue, or ack it as not for us.
  async accept(signal) {
    if (this.seen.has(signal.signalId)) return;
    this.seen.add(signal.signalId);
    try {
      if (!signal.messageId || !["mention", "dm", "reply", "direct"].includes(signal.kind)) { await this.ack([signal.signalId]); this.stats.skipped++; return; }
      const message = (await this.room.thread(signal.messageId)).thread;
      if (!mayTalk({ authorId: message.authorId, members: this.members, me: this.me, ownerId: this.ownerId, respondTo: this.respondTo })) {
      this.log(`ignored a ${signal.kind} from ${message.author ?? message.authorId} (respond-to ${this.respondTo})`);
      await this.ack([signal.signalId]); this.stats.skipped++; return;
    }
      const root = message.replyToId ? await this.threadRoot(message.replyToId) : message;
      // An "@agent allow" answer to a pending permission ask is not a new turn.
      if (this.permissions?.isPending(root.id) && decisionOf(message.body)) { await this.ack([signal.signalId]); return; }
      this.queue.push(root.id, { signalId: signal.signalId, messageId: message.id, author: message.author ?? message.authorId, body: message.body });
    } catch (error) { this.seen.delete(signal.signalId); throw error; }
  }

  async turn(threadKey, batch) {
    const signalIds = batch.map(item => item.signalId);
    let body;
    try {
      await this.agentReady();
      const thread = (await this.room.thread(threadKey)).thread;
      const { sessionId, created } = await this.host.session(threadKey);
      const prompt = buildPrompt({ roomTitle: this.title, thread, wakes: batch, firstTurn: created });
      const { recorder, stopReason } = await this.host.prompt(threadKey, prompt, { sessionId });
      body = renderTurn(recorder, { stopReason });
      this.stats.turns++;
    } catch (error) {
      this.log(`turn failed: ${error.message}`);
      if (this.controller.signal.aborted) return;
      body = renderTurn({ text: "", tools: new Map() }, { error: error.message });
    }
    try {
      await this.room.post({ body, replyToId: threadKey });
      this.stats.posted++;
      await this.ack(signalIds);
    } catch (error) {
      // Not acked: the Room re-delivers these wakes on the next poll.
      for (const id of signalIds) this.seen.delete(id);
      this.log(`posting the reply failed (${error.code ?? error.message}); will retry on re-delivery`);
    }
  }

  async pollOnce() {
    if (!(await this.lease())) { await sleep(5000, this.controller.signal); return; }
    // The Room allows 30 polls a minute per identity; stay under it even
    // when wakes arrive back to back.
    const gap = this.lastPollAt + this.minPollIntervalMs - Date.now();
    if (gap > 0) await sleep(gap, this.controller.signal);
    this.lastPollAt = Date.now();
    const value = await this.room.poll({ hostId: this.connection.hostId, waitMs: this.waitMs });
    if (value?.pendingWakes?.length) await this.refreshRoom();
    for (const signal of value?.pendingWakes ?? []) await this.accept(signal);
  }

  async run() {
    await this.host.start();
    await this.refreshRoom();
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try { await this.pollOnce(); failures = 0; }
      catch (error) {
        if (this.controller.signal.aborted) break;
        if (error instanceof RoomError && [401, 403, 410].includes(error.status)) { this.log(`room access ended (${error.code}); stopping`); this.stopReason = "access_ended"; break; }
        failures++;
        const delay = error.retryAfterMs ?? Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
        this.log(`room poll failed (${error.code ?? error.message}); retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay, this.controller.signal);
      }
    }
    await this.queue.idle();
    this.host.stop();
    return this.stopReason ?? "stopped";
  }

  stop() { this.controller.abort(); }
}
