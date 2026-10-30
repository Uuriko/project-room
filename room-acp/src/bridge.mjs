// The bridge loop: lease the room's wake queue, long-poll for mentions,
// run each thread's turn on the local ACP agent, post the reply in the
// thread, then ack the wakes. Wakes are acked only after the reply posts,
// so a crash before posting means the Room re-delivers them.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./credentials.mjs";
import { RoomClient, RoomError } from "./room.mjs";
import { AgentHost } from "./agent-host.mjs";
import { ThreadQueue } from "./queue.mjs";
import { buildPrompt, buildClaimPrompt } from "./prompt.mjs";
import { renderTurn } from "./render.mjs";
import { SessionMap } from "./sessions.mjs";
import { PermissionBroker, decisionOf, DEFAULT_PERMISSION_TIMEOUT_MS } from "./permission.mjs";

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60 * 1000;

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

// Claim wakes the bridge turns into work. Others (ci, review, lease) are acked.
export const CLAIM_WAKE_REASONS = Object.freeze(["assigned"]);
export const CLAIM_KEY = "work-claim:";
export const MAX_CLAIM_NOTE = 1500;
// The person who put the claim on the Board is who asked for the work.
export const claimRequester = claim => (claim?.history ?? []).find(entry => entry?.action === "created")?.agentId ?? null;

export function mayTalk({ authorId, members, me, ownerId, respondTo }) {
  if (!authorId || authorId === me?.id || !members[authorId] || members[authorId].active === false) return false;
  if (respondTo === "anyone") return Boolean(members[authorId] && members[authorId].active !== false);
  const boss = me?.accountableHumanId ?? ownerId;
  if (authorId === boss || authorId === ownerId) return true; // ownerId = room owner
  const author = members[authorId];
  return Boolean(author && author.kind === "agent" && author.active !== false && author.accountableHumanId === boss);
}

// Keep execution separate from delivery. An interrupted prompt may already have
// changed the outside world, so an unfinished receipt requires human recovery.
class TurnReceipts {
  constructor(connection, env, persist, namespace = "claim-turns") {
    this.scope = JSON.stringify([connection.apiBase, connection.roomId, connection.memberId]);
    this.dir = persist ? join(configDir(env), namespace) : null;
    this.memory = new Map();
  }
  key(signalId) { return createHash("sha256").update(this.scope + JSON.stringify(signalId)).digest("hex"); }
  begin(signalId) {
    const key = this.key(signalId);
    if (!this.dir) {
      if (this.memory.has(key)) return { key, receipt: this.memory.get(key), fresh: false };
      const receipt = { phase: "started", requestId: randomUUID() };
      this.memory.set(key, receipt);
      return { key, receipt, fresh: true };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, key + ".json");
    const receipt = { phase: "started", requestId: randomUUID() };
    try { writeFileSync(path, JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = this.read(key);
      return { key, receipt: existing, fresh: false };
    }
    return { key, receipt, fresh: true };
  }
  read(key) {
    const receipt = this.dir ? JSON.parse(readFileSync(join(this.dir, key + ".json"), "utf8")) : this.memory.get(key);
    if (!receipt || !["started", "result", "posted", "discarded", "linked"].includes(receipt.phase) || typeof receipt.requestId !== "string" ||
        receipt.phase === "result" && typeof receipt.body !== "string" ||
        receipt.phase === "linked" && !/^[a-f0-9]{64}$/.test(receipt.groupKey)) throw new Error("Invalid execution receipt; manual recovery required");
    return receipt;
  }
  save(key, receipt) {
    if (!this.dir) { this.memory.set(key, receipt); return; }
    const path = join(this.dir, key + ".json"), temporary = path + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, path);
  }
}

export class Bridge {
  constructor({ connection, candidate, cwd, env, mode = null, respondTo = "anyone", maxSessions = 4, waitMs = 25000, cadenceSeconds = 30, fetchImpl = fetch, log = () => {}, host = null, persistSessions = true, restartDelayMs = 1000, minPollIntervalMs = 2500, permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS, permissionPollMs = 1500, permissionApproverId = connection.permissionApproverId ?? null }) {
    this.connection = connection; this.respondTo = respondTo; this.waitMs = waitMs; this.cadenceSeconds = cadenceSeconds; this.log = log;
    this.room = new RoomClient({ apiBase: connection.apiBase, roomId: connection.roomId, memberId: connection.memberId, credential: connection.credential, fetchImpl });
    this.claimReceipts = new TurnReceipts(connection, env, persistSessions);
    this.chatReceipts = new TurnReceipts(connection, env, persistSessions, "chat-turns");
    this.sessionMap = new SessionMap({ roomId: connection.roomId, hostId: connection.hostId, env, persist: persistSessions });
    this.host = host ?? new AgentHost({ candidate, cwd, env, mode, log, savedSessions: this.sessionMap, onPermission: request => this.onPermission(request) });
    this.permissionApproverId = permissionApproverId;
    this.permissionTimeoutMs = permissionTimeoutMs; this.permissionPollMs = permissionPollMs;
    this.restartDelayMs = restartDelayMs; this.minPollIntervalMs = minPollIntervalMs; this.lastPollAt = 0; this.crashes = []; this.pausedUntil = 0; this.ready = null;
    this.queue = new ThreadQueue({ concurrency: maxSessions, run: (threadKey, batch) => this.turn(threadKey, batch) });
    this.host.onExit?.(info => this.onAgentExit(info));
    this.approverController = new AbortController();
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

  // Host tool approvals require the local operator to name a trusted human.
  // Room sponsorship or invitation never supplies this host authority.
  async onPermission(request) {
    if (!this.permissionApproverId) {
      this.log("Tool permission cancelled: Room approvals are disabled. On this laptop, explicitly choose a trusted human with --permission-approver <member-id> to enable them.");
      return { outcome: { outcome: "cancelled" } };
    }
    try { await this.refreshRoom(); } catch { return { outcome: { outcome: "cancelled" } }; }
    if (this.controller.signal.aborted || this.me.active === false || !this.approverAvailable) {
      this.log("Tool permission cancelled: the locally selected approver is not an active human in this room.");
      return { outcome: { outcome: "cancelled" } };
    }
    try { await this.assertListener(); } catch { return { outcome: { outcome: "cancelled" } }; }
    const approverId = this.permissions.approverId;
    const signal = AbortSignal.any([this.controller.signal, this.approverController.signal]);
    return this.permissions.request({ ...request, validateApproval: async () => {
      await this.refreshRoom();
      await this.assertListener();
      return !signal.aborted && this.me.active !== false && this.permissions.approverId === approverId &&
        this.approverAvailable;
    } }, signal);
  }

  async refreshRoom() {
    const value = await this.room.room();
    this.members = value?.state?.members ?? {};
    this.ownerId = value?.state?.room?.ownerId ?? null;
    this.title = value?.state?.room?.title ?? this.connection.roomId;
    this.me = this.members[this.connection.memberId] ?? { id: this.connection.memberId };
    const approverId = this.permissionApproverId;
    const approver = this.members[approverId];
    const authority = JSON.stringify([approverId, approver?.kind, approver?.identityId, approver?.accountId, approver?.active]);
    this.approverAvailable = Boolean(approver && approver.kind === "human" && approver.active !== false);
    if (this.approverAuthority !== undefined && this.approverAuthority !== authority) {
      this.approverController.abort(); this.approverController = new AbortController();
    }
    this.approverAuthority = authority;
    this.permissions ??= new PermissionBroker({ room: this.room, approverId, timeoutMs: this.permissionTimeoutMs, pollMs: this.permissionPollMs, log: this.log });
  }

  async assertListener() {
    if (!this.fencingToken || this.controller.signal.aborted) throw new RoomError(409, "stale_listener", "No active runtime lease");
    const result = await this.room.checkListener(this.fencingToken);
    if (result?.listener?.valid !== true) throw new RoomError(409, "stale_listener", "Listener validation failed");
  }

  async authorized({ messageIds, claimId } = {}) {
    if (this.controller.signal.aborted) throw new Error("bridge stopped");
    await this.refreshRoom();
    await this.assertListener();
    if (!this.members[this.connection.memberId] || this.me.active === false) return false;
    const allowed = authorId => mayTalk({ authorId, members: this.members, me: this.me, ownerId: this.ownerId, respondTo: this.respondTo });
    if (claimId) {
      const claim = await this.room.claim(claimId);
      return claim?.owner === this.me.id && allowed(claimRequester(claim));
    }
    // Old receipts lack source IDs: do not disclose their result without
    // evidence that every original requester still has access.
    if (!Array.isArray(messageIds) || !messageIds.length) return false;
    for (const id of messageIds) if (!allowed((await this.room.thread(id)).thread?.authorId)) return false;
    return true;
  }

  async lease() {
    // Renew the listener lease only when it is close to expiry: heartbeats
    // are rate limited, polls are the cheap call.
    if (this.fencingToken && Date.now() < this.leaseRenewAt) return true;
    const value = await this.room.heartbeat({ hostId: this.connection.hostId, cadenceSeconds: this.cadenceSeconds });
    this.fencingToken = value?.listener?.acquired ? value.listener.fencingToken : null;
    this.room.listenerToken = this.fencingToken;
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
      if (signal.workClaim) { await this.acceptClaim(signal); return; }
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

  // A Board claim assigned to this agent: one session per claim, reply as a
  // claim note so it lands in that claim's thread.
  async acceptClaim(signal) {
    if (!CLAIM_WAKE_REASONS.includes(signal.reason)) { await this.ack([signal.signalId]); this.stats.skipped++; return; }
    const claim = await this.room.claim(signal.workClaim);
    const authorId = claimRequester(claim);
    if (claim?.owner !== this.me.id || !mayTalk({ authorId, members: this.members, me: this.me, ownerId: this.ownerId, respondTo: this.respondTo })) {
      this.log(`ignored claim ${signal.workClaim} (${signal.reason})`);
      await this.ack([signal.signalId]); this.stats.skipped++; return;
    }
    this.queue.push(CLAIM_KEY + claim.id, { signalId: signal.signalId, claim, author: this.members[authorId]?.displayName ?? authorId });
  }

  async claimTurn(threadKey, batch) {
    // Receipt identity is per wake, independent of how polling batches it.
    for (const item of batch) await this.claimSignalTurn(threadKey, item);
  }

  async claimSignalTurn(threadKey, item) {
    const signalIds = [item.signalId];
    const claimId = threadKey.slice(CLAIM_KEY.length);
    try {
      if (this.controller.signal.aborted) return;
      if (!(await this.authorized({ claimId }))) { await this.ack(signalIds); return; }
      const { key, receipt: saved, fresh } = this.claimReceipts.begin(item.signalId);
      let receipt = saved;
      if (!fresh && receipt.phase === "started") {
        this.log(`claim ${claimId} has an interrupted execution; inspect its work before assigning a new turn`);
        return; // Never silently repeat external actions after an ambiguous crash.
      }
      if (fresh) {
        let body;
        try {
          await this.agentReady();
          if (this.controller.signal.aborted) return;
          const { sessionId } = await this.host.session(threadKey);
          if (!(await this.authorized({ claimId }))) { await this.ack(signalIds); return; }
          const { recorder, stopReason } = await this.host.prompt(threadKey, buildClaimPrompt({ roomTitle: this.title, claim: item.claim, author: item.author }), { sessionId });
          body = renderTurn(recorder, { stopReason });
          this.stats.turns++;
        } catch (error) {
          this.log(`claim turn failed: ${error.message}`);
          if (this.controller.signal.aborted) return;
          body = renderTurn({ text: "", tools: new Map() }, { error: error.message });
        }
        receipt = { ...receipt, phase: "result", body: body.length > MAX_CLAIM_NOTE ? body.slice(0, MAX_CLAIM_NOTE - 1) + "…" : body };
        this.claimReceipts.save(key, receipt);
      }
      if (receipt.phase === "result" && !(await this.authorized({ claimId }))) {
        receipt = { phase: "discarded", requestId: receipt.requestId };
        this.claimReceipts.save(key, receipt);
      }
      if (receipt.phase === "result") {
        await this.room.claimNote(claimId, receipt.body, receipt.requestId, this.fencingToken);
        this.stats.posted++;
        receipt = { phase: "posted", requestId: receipt.requestId };
        this.claimReceipts.save(key, receipt);
      }
      await this.ack(signalIds);
    } catch (error) {
      for (const id of signalIds) this.seen.delete(id);
      this.log(`claim delivery failed (${error.code ?? error.message}); retrying delivery without repeating execution`);
    }
  }

  async turn(threadKey, batch) {
    if (this.controller.signal.aborted) return;
    if (threadKey.startsWith(CLAIM_KEY)) return this.claimTurn(threadKey, batch);
    try {
      if (!(await this.authorized({ messageIds: batch.map(item => item.messageId) }))) { await this.ack(batch.map(item => item.signalId)); return; }
      const fresh = [], replay = new Set();
      for (const item of batch) {
        const saved = this.chatReceipts.begin(item.signalId);
        if (saved.fresh) fresh.push({ ...saved, item });
        else replay.add(saved.receipt.phase === "linked" ? saved.receipt.groupKey : saved.key);
      }
      // Retry original groups independently of this poll's new batching.
      for (const key of replay) {
        try { await this.deliverChatReceipt(key); }
        catch (error) { this.log(`chat delivery failed (${error.code ?? error.message}); retrying delivery without repeating execution`); }
      }
      if (!fresh.length) return;
      const { key, receipt } = fresh[0];
      const signalIds = fresh.map(entry => entry.item.signalId);
      const started = { ...receipt, threadKey, signalIds, messageIds: fresh.map(entry => entry.item.messageId) };
      this.chatReceipts.save(key, started);
      for (const entry of fresh.slice(1)) this.chatReceipts.save(entry.key, { ...entry.receipt, phase: "linked", groupKey: key });
      let body;
      try {
        await this.agentReady();
        if (this.controller.signal.aborted) return;
        const thread = (await this.room.thread(threadKey)).thread;
        const { sessionId, created } = await this.host.session(threadKey);
        if (!(await this.authorized({ messageIds: started.messageIds }))) { await this.ack(signalIds); return; }
        const prompt = buildPrompt({ roomTitle: this.title, thread, wakes: fresh.map(entry => entry.item), firstTurn: created });
        const { recorder, stopReason } = await this.host.prompt(threadKey, prompt, { sessionId });
        body = renderTurn(recorder, { stopReason });
        this.stats.turns++;
      } catch (error) {
        this.log(`turn failed: ${error.message}`);
        if (this.controller.signal.aborted) return;
        body = renderTurn({ text: "", tools: new Map() }, { error: error.message });
      }
      this.chatReceipts.save(key, { ...started, phase: "result", body });
      await this.deliverChatReceipt(key);
    } catch (error) {
      for (const item of batch) this.seen.delete(item.signalId);
      this.log(`chat delivery failed (${error.code ?? error.message}); retrying delivery without repeating execution`);
    }
  }

  async deliverChatReceipt(key) {
    let receipt = this.chatReceipts.read(key);
    if (receipt.phase === "started") {
      this.log("chat has an interrupted execution; inspect its work before sending a new request");
      return;
    }
    if (!Array.isArray(receipt.signalIds) || typeof receipt.threadKey !== "string") throw new Error("Invalid chat execution receipt; manual recovery required");
    try {
      if (receipt.phase === "result" && !(await this.authorized({ messageIds: receipt.messageIds }))) {
        const { body: _body, ...discarded } = receipt;
        receipt = { ...discarded, phase: "discarded" };
        this.chatReceipts.save(key, receipt);
      }
      if (receipt.phase === "result") {
        await this.room.post({ body: receipt.body, replyToId: receipt.threadKey,
          messageId: `acp-${receipt.requestId}`, requestId: receipt.requestId, listenerToken: this.fencingToken });
        this.stats.posted++;
        const { body: _body, ...delivered } = receipt;
        receipt = { ...delivered, phase: "posted" };
        this.chatReceipts.save(key, receipt);
      }
      await this.ack(receipt.signalIds);
    } catch (error) {
      for (const id of receipt.signalIds) this.seen.delete(id);
      throw error;
    }
  }

  async pollOnce() {
    if (!(await this.lease())) { await sleep(5000, this.controller.signal); return; }
    // The Room allows 30 polls a minute per identity; stay under it even
    // when wakes arrive back to back.
    const gap = this.lastPollAt + this.minPollIntervalMs - Date.now();
    if (gap > 0) await sleep(gap, this.controller.signal);
    if (this.controller.signal.aborted) return;
    this.lastPollAt = Date.now();
    const value = await this.room.poll({ hostId: this.connection.hostId, waitMs: this.waitMs, signal: this.controller.signal });
    if (value?.pendingWakes?.length) await this.refreshRoom();
    for (const signal of value?.pendingWakes ?? []) {
      if (this.controller.signal.aborted) break;
      await this.accept(signal);
    }
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
    this.stop();
    await this.queue.idle();
    // Say goodbye so presence stops reading "listening" right away and
    // mentions show as queued. Best effort: a crash still ages out.
    try { await this.room.disconnect({ hostId: this.connection.hostId, fencingToken: this.fencingToken }); } catch { /* best effort */ }
    this.fencingToken = null;
    return this.stopReason ?? "stopped";
  }

  stop() { this.controller.abort(); this.host.stop?.(); }
}
