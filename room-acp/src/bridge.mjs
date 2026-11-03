// The bridge loop: lease the room's wake queue, long-poll for mentions,
// run each thread's turn on the local ACP agent, post the reply in the
// thread, then ack the wakes. Wakes are acked after the reply posts or a
// successful ordinary empty turn has a persisted silent disposition.
// Incomplete execution stays available for explicit recovery.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./credentials.mjs";
import { RoomClient, RoomError } from "./room.mjs";
import { AgentHost } from "./agent-host.mjs";
import { ThreadQueue } from "./queue.mjs";
import { buildPrompt, buildClaimPrompt, buildFormalPrompt } from "./prompt.mjs";
import { readCompleteRequest, prepareFormalDelivery, deliverFormal } from './formal-delivery.mjs';
import { renderTurn } from "./render.mjs";
import { SessionMap } from "./sessions.mjs";
import { PermissionBroker, decisionOf, DEFAULT_PERMISSION_TIMEOUT_MS } from "./permission.mjs";

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60 * 1000;
// The Room pages pending wakes (50 per page) and reports more/nextCursor.
// One poll cycle follows at most this many pages, so a queue that grows
// while the bridge sleeps drains across cycles instead of looping here.
export const MAX_POLL_PAGES = 20;

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

// Claim wakes the bridge turns into work. Others (ci, review, lease) are acked.
export const CLAIM_WAKE_REASONS = Object.freeze(["assigned"]);
// Terminal claim states, mirroring TERMINAL_CLAIM_STATES in
// server/work-claims.mjs (STATES there has no "cancelled" state: cancel is a
// verb that lands a claim in "closed"). A fresh wake naming a claim already
// in one of these states must not run another turn: the same-signalId path
// is already deduped by the persisted TurnReceipt, but a fresh signalId
// (reassign-after-done, admin re-wake, wake regeneration) has no receipt.
export const TERMINAL_CLAIM_STATES = Object.freeze(["done", "closed"]);
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
  begin(signalId, initial = {}) {
    const key = this.key(signalId);
    const receipt = { ...initial, phase: initial.phase ?? 'started', requestId: randomUUID() };
    if (!this.dir) {
      if (this.memory.has(key)) return { key, receipt: this.memory.get(key), fresh: false };
      this.memory.set(key, receipt);
      return { key, receipt, fresh: true };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, key + ".json");
    const temporary=path+'.'+randomUUID()+'.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(receipt), {flag:'wx',mode:0o600});
      linkSync(temporary,path); // Atomic complete-file commit, without replacing an existing operation.
    }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = this.read(key);
      return { key, receipt: existing, fresh: false };
    } finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    return { key, receipt, fresh: true };
  }
  read(key) {
    const receipt = this.dir ? JSON.parse(readFileSync(join(this.dir, key + ".json"), "utf8")) : this.memory.get(key);
    if (!receipt || !["queued", "started", "result", "needs_review", "posted", "discarded", "linked"].includes(receipt.phase) || typeof receipt.requestId !== "string" ||
        ['result','needs_review'].includes(receipt.phase) && typeof receipt.body !== "string" ||
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
    this.restartDelayMs = restartDelayMs; this.minPollIntervalMs = minPollIntervalMs; this.lastPollAt = 0; this.wakeCursor = null; this.crashes = []; this.pausedUntil = 0; this.ready = null;
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
    // A spawned process becomes "running" before ACP initialize completes.
    // Always await the active restart, including any replacement restart
    // scheduled after an initialization failure.
    while (this.ready && !this.controller.signal.aborted) {
      const pending = this.ready;
      await pending;
      if (this.ready === pending) break;
    }
  }

  // Host tool approvals require the local operator to name a trusted human.
  // Room sponsorship or invitation never supplies this host authority.
  async onPermission(request) {
    if (!this.permissionApproverId) {
      this.log("Tool permission cancelled: Room approvals are disabled. On this laptop, explicitly choose a trusted human with --permission-approver <member-id> to enable them.");
      return { outcome: { outcome: "cancelled" } };
    }
    let authority;
    try { authority=await this.refreshRoom(); } catch { return { outcome: { outcome: "cancelled" } }; }
    if (this.controller.signal.aborted || authority.me.active === false || !authority.approverAvailable) {
      this.log("Tool permission cancelled: the locally selected approver is not an active human in this room.");
      return { outcome: { outcome: "cancelled" } };
    }
    try { await this.assertListener(); } catch { return { outcome: { outcome: "cancelled" } }; }
    const approverId = this.permissions.approverId;
    const signal = AbortSignal.any([this.controller.signal, this.approverController.signal]);
    return this.permissions.request({ ...request, validateApproval: async () => {
      const current=await this.refreshRoom();
      await this.assertListener();
      return !signal.aborted && current.me.active !== false && this.permissions.approverId === approverId &&
        current.approverAvailable;
    } }, signal);
  }

  async refreshRoom({ memberIds = [] } = {}) {
    const value = await this.room.room({ authorityFor: [...new Set([...memberIds, this.permissionApproverId].filter(Boolean))] });
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
    // Keep each turn's selection local: another concurrent turn may refresh
    // a different author set while this one awaits its listener check.
    return {members:this.members,ownerId:this.ownerId,me:this.me,approverAvailable:this.approverAvailable,
      unresolved:new Set(value.authoritySelection?.unresolvedMemberIds??[])};
  }

  async assertListener() {
    if (!this.fencingToken || this.controller.signal.aborted) throw new RoomError(409, "stale_listener", "No active runtime lease");
    const result = await this.room.checkListener(this.fencingToken);
    if (result?.listener?.valid !== true) throw new RoomError(409, "stale_listener", "Listener validation failed");
  }

  async messageAuthority(messageIds) {
    const authors = [];
    for (const id of messageIds) authors.push((await this.readThread(id, {selected:true})).thread?.authorId);
    const authority = await this.refreshRoom({memberIds:authors.filter(Boolean)});
    await this.assertListener();
    return new Map(messageIds.map((id,index) => [id,
      authority.unresolved.has(authors[index]) ? 'unresolved'
        : authority.members[this.connection.memberId] && authority.me.active !== false
          && mayTalk({authorId:authors[index],members:authority.members,me:authority.me,
            ownerId:authority.ownerId,respondTo:this.respondTo}) ? 'allowed' : 'denied']));
  }

  async authorized({ messageIds, claimId, requireRunnable = false } = {}) {
    if (this.controller.signal.aborted) throw new Error("bridge stopped");
    if (!claimId) {
      // Old receipts lack original source IDs; they cannot authorize disclosure.
      if (!Array.isArray(messageIds) || !messageIds.length) return false;
      const statuses = [...(await this.messageAuthority(messageIds)).values()];
      if (statuses.includes('unresolved'))
        throw new RoomError(409, 'authority_member_unresolved', 'A request author is unresolved; retain the wake without executing or acknowledging it');
      return statuses.every(status => status === 'allowed');
    }
    const initial = await this.room.claim(claimId), requester = claimRequester(initial);
    const authority = await this.refreshRoom({memberIds:[requester].filter(Boolean)});
    await this.assertListener();
    // Assignment may change during the authority read or listener check.
    const claim = await this.room.claim(claimId);
    if (claimRequester(claim) !== requester || authority.unresolved.has(requester))
      throw new RoomError(409, 'authority_member_unresolved', 'Claim requester changed or is unresolved; retry with fresh authority');
    return Boolean(authority.members[this.connection.memberId] && authority.me.active !== false
      && claim?.owner === authority.me.id && (!requireRunnable || !TERMINAL_CLAIM_STATES.includes(claim.state))
      && mayTalk({authorId:requester,members:authority.members,
        me:authority.me,ownerId:authority.ownerId,respondTo:this.respondTo}));
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

  stopForContextLimit(error) {
    if (error instanceof RoomError && error.status === 409 && error.code === "wake_scope_unavailable") {
      this.stopReason = "context_unavailable";
      this.log("Room did not confirm the selected wake scope. Upgrade the server and check the saved room before restarting; foreign wakes remain unacknowledged.");
      this.stop(); return true;
    }
    if (!(error instanceof RoomError) || !(error.status === 413 && ['current_thread_too_large','formal_context_too_large'].includes(error.code)
      || error.status === 409 && ['selected_message_context_unavailable','selected_authority_unavailable'].includes(error.code))) return false;
    if (this.stopReason !== "context_unavailable") {
      this.stopReason = "context_unavailable";
      this.log("Room context is unavailable or exceeds this bridge's bounded context. Stopping; the wake remains unacknowledged. Inspect the request in Room before restarting.");
    }
    this.stop();
    return true;
  }

  async readThread(messageId, options) {
    try { return await this.room.thread(messageId, options); }
    catch (error) { this.stopForContextLimit(error); throw error; }
  }

  async threadRoot(messageId) {
    let selected = await this.readThread(messageId, {selected:true});
    for (let hops = 0; selected.thread.replyToId && hops < 5; hops++) {
      if (selected.replyRequest?.recipientId === this.connection.memberId) break;
      selected = await this.readThread(selected.thread.replyToId, {selected:true});
    }
    return selected.thread;
  }

  // Route one wake signal into the queue, or ack it as not for us.
  async accept(signal) {
    if (this.seen.has(signal.signalId)) return;
    this.seen.add(signal.signalId);
    try {
      if (signal.workClaim) { await this.acceptClaim(signal); return; }
      if (!signal.messageId || !["mention", "dm", "reply", "direct"].includes(signal.kind)) { await this.ack([signal.signalId]); this.stats.skipped++; return; }
      const message = (await this.readThread(signal.messageId, {selected:true})).thread;
      // Routing does not authorize execution. The queued turn checks all
      // actual stored request authors against a fresh selected authority read.
      const root = message.replyToId ? await this.threadRoot(message.id) : message;
      // An "@agent allow" answer to a pending permission ask is not a new turn.
      if (this.permissions?.isPending(root.id) && decisionOf(message.body)) { await this.ack([signal.signalId]); return; }
      this.queue.push(root.id, { signalId: signal.signalId, messageId: message.id, author: message.author ?? message.authorId, body: message.body });
    } catch (error) { this.seen.delete(signal.signalId); throw error; }
  }

  // A Board claim assigned to this agent: one session per claim, reply as a
  // claim note so it lands in that claim's thread.
  async acceptClaim(signal) {
    if (!CLAIM_WAKE_REASONS.includes(signal.reason)) { await this.ack([signal.signalId]); this.stats.skipped++; return; }
    let claim;
    try { claim = await this.room.claim(signal.workClaim); }
    catch (error) {
      if (!(error instanceof RoomError) || error.status !== 404 || error.code !== 'work_claim_not_found') throw error;
      // A definitive absent claim must not strand unrelated current wakes.
      // Recheck room access and the listener before retiring this old signal.
      const authority = await this.refreshRoom();
      await this.assertListener();
      if (signal.roomId !== this.connection.roomId || !authority.members[this.connection.memberId] || authority.me.active === false)
        throw new RoomError(403, 'access_denied', 'Missing claim wake is not bound to this active room member');
      const {receipt} = this.claimReceipts.begin(signal.signalId, {phase:'discarded', disposition:'claim_missing'});
      if (!['posted', 'discarded'].includes(receipt.phase)) {
        this.log(`claim ${signal.workClaim} is missing; retained ${receipt.phase} execution for inspection without acknowledgement`);
        return;
      }
      await this.ack([signal.signalId]); this.stats.skipped++; return;
    }
    if (TERMINAL_CLAIM_STATES.includes(claim?.state)) {
      this.log(`ignored claim ${signal.workClaim} (${signal.reason}): claim is ${claim.state} (terminal)`);
      await this.ack([signal.signalId]); this.stats.skipped++; return;
    }
    const authorId = claimRequester(claim);
    if (claim?.owner !== this.connection.memberId) {
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
      if (!(await this.authorized({ claimId }))) { await this.ack(signalIds); this.stats.skipped++; return; }
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
          // Queueing and session startup can outlive the assignment. Check
          // runnable state here without blocking results already in progress.
          if (!(await this.authorized({ claimId, requireRunnable: true }))) {
            receipt = { phase: "discarded", requestId: receipt.requestId };
            this.claimReceipts.save(key, receipt);
            await this.ack(signalIds); return;
          }
          const { recorder, stopReason } = await this.host.prompt(threadKey, buildClaimPrompt({ roomTitle: this.title, claim: item.claim, author: item.author }), { sessionId });
          body = renderTurn(recorder, { stopReason });
          this.stats.turns++;
        } catch (error) {
          if (receipt.phase === "discarded") throw error; // Retry ACK without creating a result.
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
      const fresh = [], replay = new Map(), unique = new Set();
      for (const item of batch) {
        if (unique.has(item.signalId)) continue;
        unique.add(item.signalId);
        // A crash even before grouping must retain a complete, executable
        // pre-execution record. Claim receipts keep their existing default.
        const saved = this.chatReceipts.begin(item.signalId, {phase:'queued', threadKey,
          signalIds:[item.signalId], messageIds:[item.messageId], wakes:[{author:item.author, body:item.body}]});
        if (saved.fresh) fresh.push({ ...saved, item });
        else {
          const groupKey = saved.receipt.phase === "linked" ? saved.receipt.groupKey : saved.key;
          if (!replay.has(groupKey)) replay.set(groupKey, []);
          replay.get(groupKey).push(item.signalId);
        }
      }
      // Retry original groups independently of this poll's new batching.
      for (const [key, signalIds] of replay) {
        try { await this.deliverChatReceipt(key); }
        catch (error) {
          for (const id of signalIds) this.seen.delete(id);
          this.log(`chat delivery failed (${error.code ?? error.message}); retrying delivery without repeating execution`);
          if (this.stopForContextLimit(error)) return;
        }
      }
      if (!fresh.length) return;
      // Only new inputs may be partitioned. Original replay groups retain all
      // source authors and are revalidated together before disclosure.
      const statuses = await this.messageAuthority(fresh.map(entry => entry.item.messageId));
      for (let index = fresh.length - 1; index >= 0; index--) {
        const entry = fresh[index], status = statuses.get(entry.item.messageId);
        if (status === 'allowed') continue;
        fresh.splice(index, 1);
        if (status === 'unresolved') {
          this.seen.delete(entry.item.signalId);
          this.log('Request author unresolved; retaining wake without execution or acknowledgement');
        } else {
          this.chatReceipts.save(entry.key, {...entry.receipt,phase:'discarded'});
          await this.deliverChatReceipt(entry.key);
          this.stats.skipped++;
        }
      }
      if (!fresh.length) return;
      const { key, receipt } = fresh[0];
      const signalIds = fresh.map(entry => entry.item.signalId);
      const queued = { ...receipt, phase: 'queued', threadKey, signalIds, messageIds: fresh.map(entry => entry.item.messageId),
        wakes: fresh.map(entry => ({author:entry.item.author, body:entry.item.body})) };
      this.chatReceipts.save(key, queued);
      for (const entry of fresh.slice(1)) this.chatReceipts.save(entry.key, {requestId:entry.receipt.requestId, phase: "linked", groupKey: key});
      await this.deliverChatReceipt(key);
    } catch (error) {
      this.stopForContextLimit(error);
      for (const item of batch) this.seen.delete(item.signalId);
      this.log(`chat delivery failed (${error.code ?? error.message}); retrying delivery without repeating execution`);
    }
  }

  async executeQueuedChatReceipt(key, receipt) {
    // Repair a crash during the per-signal link writes. An unlinked queued
    // sibling has never executed and can join this group. A sibling already
    // delivered in another replay order must not execute a second time.
    const included=[];
    for (let i=0;i<receipt.signalIds.length;i++) {
      const siblingKey=this.chatReceipts.key(receipt.signalIds[i]);
      if (siblingKey===key) {included.push(i);continue;}
      let sibling=this.chatReceipts.read(siblingKey);
      if (sibling.phase==='queued' && sibling.signalIds?.length===1) {
        this.chatReceipts.save(siblingKey,{requestId:sibling.requestId,phase:'linked',groupKey:key});
        included.push(i);continue;
      }
      if (sibling.phase==='linked' && sibling.groupKey===key) {included.push(i);continue;}
      if (sibling.phase==='result' || sibling.phase==='linked') {
        await this.deliverChatReceipt(siblingKey);
        sibling=this.chatReceipts.read(sibling.phase==='linked'?sibling.groupKey:siblingKey);
      }
      if (!['posted','discarded'].includes(sibling.phase)) {
        this.log('Grouped chat has an unresolved execution; inspect it before starting another turn');return;
      }
    }
    if (included.length!==receipt.signalIds.length) {
      receipt={...receipt,signalIds:included.map(i=>receipt.signalIds[i]),messageIds:included.map(i=>receipt.messageIds[i]),
        wakes:included.map(i=>receipt.wakes?.[i]).filter(Boolean)};
      this.chatReceipts.save(key,receipt);
    }
    // Only queued means no prompt has started. Persist started immediately
    // before execution; after a crash that state is never silently rerun.
    if (!(await this.authorized({messageIds:receipt.messageIds}))) {
      this.chatReceipts.save(key, {...receipt, phase:'discarded'}); return;
    }
    await this.agentReady();
    if (this.controller.signal.aborted) return;
    const selected = await this.readThread(receipt.threadKey, {selected:true});
    let formal = selected.replyRequest?.recipientId === this.connection.memberId
      ? await readCompleteRequest(this.room, receipt.threadKey) : null;
    if (formal && (formal.request.status !== 'open' || formal.current?.actions?.answer !== true)) {
      this.chatReceipts.save(key, {...receipt, phase:'discarded'}); return;
    }
    const thread = formal ? selected.thread : (await this.readThread(receipt.threadKey)).thread;
    const {sessionId, created} = await this.host.session(receipt.threadKey);
    if (formal) {
      // Session startup may wait while the requester cancels or adds context.
      // Only the fresh complete request can authorize and prepare this turn.
      formal = await readCompleteRequest(this.room, receipt.threadKey);
      if (formal.request.status !== 'open' || formal.current?.actions?.answer !== true) {
        this.chatReceipts.save(key, {...receipt, phase:'discarded'}); return;
      }
    }
    if (!(await this.authorized({messageIds:receipt.messageIds}))) {
      this.chatReceipts.save(key, {...receipt, phase:'discarded'}); return;
    }
    const wakes = receipt.wakes ?? [];
    const prompt = formal ? buildFormalPrompt(formal)
      : buildPrompt({roomTitle:this.title, thread, wakes, firstTurn:created});
    const started = {...receipt, phase:'started', ...(formal ? {formalContext:formal} : {})};
    this.chatReceipts.save(key, started);
    let body, formalDelivery, formalPending, formalDraft, silent = false;
    try {
      const {recorder, stopReason} = await this.host.prompt(receipt.threadKey, prompt, {sessionId});
      this.stats.turns++;
      if (formal) {
        const delivery = prepareFormalDelivery(formal, recorder.text, stopReason);
        body = delivery.kind === 'formal' ? delivery.recipe.command.data.body : delivery.body;
        if (delivery.kind === 'formal') formalDelivery = delivery;
        else { formalPending = delivery.pendingReason; formalDraft = delivery.draft; }
      } else {
        // Silence is a successful ordinary outcome, never an inferred failure,
        // formal answer, tool result, plan, early stop or uncertain execution.
        silent = stopReason === 'end_turn' && typeof recorder.text === 'string' && !recorder.text.trim()
          && recorder.tools instanceof Map && recorder.tools.size === 0
          && (recorder.plan === undefined || Array.isArray(recorder.plan) && recorder.plan.length === 0);
        if (!silent) body = renderTurn(recorder, {stopReason});
      }
    } catch (error) {
      this.log(`turn failed: ${error.message}`);
      if (this.controller.signal.aborted) return;
      body = formal ? 'The agent turn failed. This request remains open.'
        : renderTurn({text:'', tools:new Map()}, {error:error.message});
    }
    // Save the exact filled recipe and answer BEFORE the first network send.
    // Drop the input copy after execution, retaining it only for an interrupted
    // started receipt that may need local inspection.
    const {formalContext:_context, wakes:_wakes, ...result} = started;
    // Reuse the terminal ACK-only phase so an older reader cannot replay a
    // silent turn as new work. The explicit disposition records why no post exists.
    this.chatReceipts.save(key, silent ? {...result, phase:'discarded', disposition:'silent'}
      : {...result, phase:'result', body, ...(formalDelivery ? {formalDelivery} : {}),
        ...(formalPending ? {formalPending} : {}), ...(formalDraft ? {formalDraft} : {})});
  }

  async deliverChatReceipt(key) {
    let receipt = this.chatReceipts.read(key);
    if (receipt.phase==='linked') return this.deliverChatReceipt(receipt.groupKey);
    if (receipt.phase==='needs_review') return;
    if (receipt.phase === 'queued') {
      await this.executeQueuedChatReceipt(key, receipt);
      receipt = this.chatReceipts.read(key);
      if (receipt.phase === 'queued') return;
    }
    if (receipt.phase === "started") {
      this.log("chat has an interrupted execution; inspect its work before sending a new request");
      return;
    }
    if (!Array.isArray(receipt.signalIds) || typeof receipt.threadKey !== "string") throw new Error("Invalid chat execution receipt; manual recovery required");
    try {
      if (receipt.phase === "result" && !(await this.authorized({ messageIds: receipt.messageIds }))) {
        const { body: _body, formalDelivery:_delivery, ...discarded } = receipt;
        receipt = { ...discarded, phase: "discarded" };
        this.chatReceipts.save(key, receipt);
      }
      if (receipt.phase === "result") {
        if (receipt.formalDelivery && !receipt.formalReview) {
          try { await deliverFormal(this.room, receipt.formalDelivery, this.fencingToken); }
          catch (error) {
            if (error instanceof RoomError && ['formal_context_invalid','formal_response_changed'].includes(error.code)) {
              this.chatReceipts.save(key,{...receipt,phase:'needs_review'});
              this.log('Saved formal response no longer matches Room. Retained for review; not resending or rerunning execution.');
              return;
            }
            // Only a definitive CAS rejection permits changing delivery mode.
            // Unknown results retain the identical recipe until reconciled.
            if (!(error instanceof RoomError) || error.status !== 409 || error.code !== 'command_rejected'
              || !/^Stale reply request (revision|context)$/.test(error.message)) throw error;
            const revision=receipt.formalDelivery.recipe.command.data.expectedRequestRevision;
            receipt={...receipt, formalReview:true,
              body:`The request changed while I worked (prepared revision ${revision}). This is a draft for review, not a completed answer.\n\n${receipt.body}`};
            this.chatReceipts.save(key, receipt);
          }
        }
        if (!receipt.formalDelivery || receipt.formalReview) await this.room.post({ body: receipt.body, replyToId: receipt.threadKey,
          messageId: `acp-${receipt.requestId}`, requestId: receipt.requestId, listenerToken: this.fencingToken });
        this.stats.posted++;
        const { body: _body, formalDelivery:_delivery, ...delivered } = receipt;
        receipt = { ...delivered, phase: "posted" };
        this.chatReceipts.save(key, receipt);
      }
      await this.ack(receipt.signalIds);
    } catch (error) {
      this.stopForContextLimit(error);
      for (const id of receipt.signalIds) this.seen.delete(id);
      throw error;
    }
  }

  async pollOnce() {
    if (!(await this.lease())) { await sleep(5000, this.controller.signal); return; }
    // Drain every queued page in this cycle: signals on later pages are
    // just as queued as the first page's, and a first-page signal that
    // cannot ack yet (a long turn, a parked receipt) must not hide them.
    // Later pages are already waiting, so they are read without a wait.
    // A filtered source window can be empty yet have more. Carry its read
    // position across finite cycles; restart/terminal traversal starts fresh.
    let cursor = this.wakeCursor;
    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      if (this.controller.signal.aborted) return;
      // Every page is an HTTP poll and counts toward the identity's 30/min
      // limit. Pace continuation pages too, without losing their cursor.
      const gap = this.lastPollAt + this.minPollIntervalMs - Date.now();
      if (gap > 0) await sleep(gap, this.controller.signal);
      if (this.controller.signal.aborted) return;
      // A multi-page traversal may outlast a lease renewal interval.
      if (page > 0 && !(await this.lease())) return;
      this.lastPollAt = Date.now();
      const value = await this.room.poll({ hostId: this.connection.hostId, waitMs: page === 0 && cursor === null ? this.waitMs : 0, signal: this.controller.signal, cursor });
      const wakes = value?.pendingWakes ?? [];
      for (const signal of wakes) {
        if (this.controller.signal.aborted) break;
        await this.accept(signal);
      }
      if (!value?.more) { this.wakeCursor = null; return; }
      if (typeof value.nextCursor !== "string" || !value.nextCursor || value.nextCursor.length > 1024 || value.nextCursor === cursor)
        throw new RoomError(502, "invalid_wake_cursor", "Room returned a non-progressing wake continuation");
      this.wakeCursor = cursor = value.nextCursor;
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
        if (this.stopForContextLimit(error)) break;
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
