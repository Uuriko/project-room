// One Durable Object per machine. It keeps the daemon's outbound WebSocket,
// the enroll verifier hash, haltEpoch, and the lease it last checked.
// Hibernation holds the socket; in-flight calls live only while this
// isolate is awake, and a halt rejects them before the call timeout.

import { DurableObject } from "cloudflare:workers";
import { authorize } from "./auth.mjs";
import { controlFrameOnLink } from "./protocol.mjs";
import { bytesToB64url, sha256Hex, timingEqual } from "./bytes.mjs";
import { RelayError, relayError } from "./errors.mjs";
import { verifyLinkSignature } from "./hmac.mjs";
import { errorResponse, json, readJson } from "./http.mjs";
import { initializeResult, parseRpc, requireToolName, rpcError, rpcResult, toolEnvelope } from "./mcp.mjs";
import { redact } from "./redact.mjs";
import { assertFreshControlSignature } from "./replay-guard.mjs";
import {
  CALL_TIMEOUT_MS, HEARTBEAT_MS, HMAC_SKEW_SEC, MAX_CALL_BYTES, MAX_PAUSE_MINUTES, MAX_RESULT_BYTES, MAX_SMALL_BYTES, PROTOCOL_VERSION,
  isPauseMinutes, isResourceId, isSlot, listedTools, toolAllowed,
} from "./protocol.mjs";

// L4: no wildcard CORS with Authorization allowed. The request origin is
// echoed only when it appears in the RELAY_CORS_ORIGINS allowlist
// (comma-separated); otherwise no allow-origin header is sent.
function mcpHeaders(env, request) {
  const allowlist = String(env.RELAY_CORS_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin") ?? "";
  const headers = {
    "access-control-expose-headers": "mcp-protocol-version, mcp-session-id, www-authenticate",
  };
  if (origin && allowlist.includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function emptyState(machineId) {
  return {
    machineId,
    label: "",
    roomId: "",
    rooms: [],
    ownerMemberId: "",
    inviteCode: "",
    displayName: null,
    roomOrigin: "",
    resourceId: null,
    tokenHash: null,
    enroll: null,
    haltEpoch: 0,
    halted: false,
    pausedUntil: null,
    lastHeartbeat: null,
    activeLease: null,
    leases: {},
    revoked: [],
    identityCache: [],
    decisionCache: [],
    // Signatures of honored control requests (halt/resume/pause/bye),
    // pruned past the HMAC skew window + margin. A captured signed
    // request cannot be replayed inside the window.
    replayedControls: [],
  };
}

export class MachineLink extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
    this.loaded = false;
    this.state = null;
    this.dirty = false;
    this.tail = Promise.resolve();
    this.live = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname === "/mint" || url.pathname === "/enroll" || url.pathname === "/expire-enroll"
      ? url.pathname.slice(1)
      : url.pathname === "/v0/machines/link"
        ? "link"
        : /^\/v0\/machines\/[^/]+\/(link|mcp|call|halt|pause|resume|bye|status)$/.exec(url.pathname)?.[1];
    try {
      if (route === "mint") return await this.mint(request);
      if (route === "enroll") return await this.enroll(request);
      if (route === "expire-enroll") return await this.expireEnroll();
      if (route === "link") return await this.link(request);
      if (route === "mcp") return await this.mcp(request);
      if (route === "call") return await this.call(request);
      if (route === "halt") return await this.halt(request);
      if (route === "pause") return await this.pause(request);
      if (route === "resume") return await this.resume(request);
      if (route === "bye") return await this.bye(request);
      if (route === "status") return await this.status(request);
      return json(404, { error: { code: "not_found", message: "Not found" } });
    } catch (error) {
      if (!(error instanceof RelayError)) console.error(JSON.stringify(redact({ where: "machine", message: String(error?.message ?? error) })));
      const headers = route === "mcp" ? mcpHeaders(this.env, request) : {};
      return errorResponse(error, headers);
    }
  }

  async exclusive(fn) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!this.loaded) {
        this.state = await this.ctx.storage.get("machine") ?? null;
        this.loaded = true;
      }
      return await fn();
    } finally {
      try {
        if (this.dirty && this.state) {
          await this.ctx.storage.put("machine", this.state);
          this.dirty = false;
        }
      } finally {
        release();
      }
    }
  }

  daemon() {
    if (usableSocket(this.live)) return this.live;
    const sockets = this.ctx.getWebSockets().filter(usableSocket);
    return sockets.length > 0 ? sockets[sockets.length - 1] : null;
  }

  async alarm() {
    const socket = this.daemon();
    if (!socket) return;
    this.send(socket, { type: "heartbeat" });
    await this.exclusive(() => {
      if (!this.state) return;
      this.state.lastHeartbeat = new Date().toISOString();
      this.dirty = true;
    });
    if (this.daemon()) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async webSocketMessage(ws, message) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
      try { ws.close(1009, "frame too large"); } catch { /* already closed */ }
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "result") {
      let pending = null;
      await this.exclusive(() => {
        pending = this.pending.get(msg.id) ?? null;
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
        }
      });
      if (!pending) return;
      if (msg.ok === true) pending.resolve({ ok: true, result: msg.result ?? null });
      else pending.resolve({ ok: false, error: msg.error ?? { code: "tool_failed", message: "The machine refused the call" } });
      return;
    }
    if (msg.type !== "hello" && msg.type !== "heartbeat") return;
    let accepted = false;
    let control = null;
    await this.exclusive(() => {
      if (!this.state) return;
      if (msg.type === "hello") {
        if (msg.protocol !== PROTOCOL_VERSION || msg.machineId !== this.state.machineId) return;
        if (typeof msg.label !== "string" || typeof msg.version !== "string") return;
        control = controlFrameOnLink(this.state, Date.now());
      }
      this.state.lastHeartbeat = new Date().toISOString();
      this.dirty = true;
      accepted = true;
    });
    if (msg.type === "hello" && !accepted) {
      try { ws.close(1002, "protocol"); } catch { /* already closed */ }
    }
    // A halt or pause issued while the daemon was offline reaches it now.
    if (accepted && control) this.send(ws, control);
  }

  async webSocketClose(ws) {
    if (this.live === ws) this.live = null;
    if (!this.daemon()) await this.disarmHeartbeat();
  }

  async webSocketError(ws) {
    if (this.live === ws) this.live = null;
    if (!this.daemon()) await this.disarmHeartbeat();
  }

  send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch { /* socket already closed */ }
  }

  async mint(request) {
    const { value } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    await this.exclusive(() => {
      if (this.state) throw relayError(409, "machine_exists", "That machine already exists");
      this.state = emptyState(value.machineId);
      this.state.label = value.label;
      this.state.roomId = value.roomId;
      this.state.rooms = value.rooms;
      this.state.ownerMemberId = value.ownerMemberId;
      this.state.inviteCode = value.inviteCode;
      this.state.displayName = value.displayName ?? null;
      this.state.roomOrigin = value.roomOrigin || "";
      this.state.enroll = { codeHash: value.codeHash, expiresAt: value.expiresAt, used: false };
      // W5-M5: passthrough mode is per-machine opt-in, off by default, on top of
      // the global RELAY_PHASE0_PASSTHROUGH flag. passthroughCaps scopes the
      // tools a passthrough lease may drive (replacing the old caps: null).
      this.state.passthroughOptIn = value.passthroughOptIn === true;
      this.state.passthroughCaps = Array.isArray(value.passthroughCaps)
        ? value.passthroughCaps.filter(cap => typeof cap === "string" && cap.length > 0 && cap.length <= 64)
        : null;
      this.dirty = true;
    });
    return json(201, { machineId: value.machineId, expiresAt: value.expiresAt });
  }

  async enroll(request) {
    const { value } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let issued = null;
    try {
      await this.exclusive(async () => {
        if (!this.state?.enroll) throw relayError(401, "code_invalid", "The enroll code was refused");
        const hash = await sha256Hex(value.verifier);
        if (!timingEqual(hash, this.state.enroll.codeHash ?? "")) throw relayError(401, "code_invalid", "The enroll code was refused");
        if (this.state.enroll.used) throw relayError(410, "code_used", "The enroll code was already used");
        // L3: a corrupt (NaN) expiresAt must fail closed, not fail open.
        if (!Number.isFinite(Date.parse(this.state.enroll.expiresAt)) || Date.parse(this.state.enroll.expiresAt) <= Date.now()) {
          throw relayError(410, "code_expired", "The enroll code has expired");
        }
        const token = `${this.state.machineId}.${bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))}`;
        this.state.tokenHash = await sha256Hex(token);
        this.state.enroll = { codeHash: this.state.enroll.codeHash, expiresAt: this.state.enroll.expiresAt, used: true };
        this.dirty = true;
        issued = {
          machineToken: token,
          machineId: this.state.machineId,
          label: this.state.label,
          roomId: this.state.roomId,
          ownerMemberId: this.state.ownerMemberId,
          inviteCode: this.state.inviteCode,
          displayName: this.state.displayName,
          roomOrigin: this.state.roomOrigin,
        };
      });
    } catch (error) {
      if (error instanceof RelayError && (error.code === "code_invalid" || error.code === "code_used" || error.code === "code_expired")) {
        return json(error.status, { error: error.code });
      }
      throw error;
    }
    return json(200, issued);
  }

  async expireEnroll() {
    await this.exclusive(() => {
      if (!this.state?.enroll || this.state.enroll.used) throw relayError(409, "enroll_not_pending", "There is no unused enroll code");
      this.state.enroll = { ...this.state.enroll, expiresAt: new Date(0).toISOString() };
      this.dirty = true;
    });
    return json(200, { expired: true });
  }

  async link(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw relayError(426, "upgrade_required", "The machine link is a WebSocket");
    }
    const url = new URL(request.url);
    if (url.searchParams.has("token") || url.searchParams.has("machineToken")) {
      throw relayError(401, "unauthenticated", "The machine token was refused");
    }
    const token = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
      || request.headers.get("x-machine-token")
      || "";
    let replaced = [];
    let response = null;
    let server = null;
    await this.exclusive(async () => {
      if (!this.state?.tokenHash) throw relayError(401, "unauthenticated", "The machine token was refused");
      const hash = await sha256Hex(token);
      if (!timingEqual(hash, this.state.tokenHash)) throw relayError(401, "unauthenticated", "The machine token was refused");
      const pair = new WebSocketPair();
      const client = pair[0];
      server = pair[1];
      this.ctx.acceptWebSocket(server);
      this.live = server;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== server) {
          this.send(socket, { type: "bye" });
          try { socket.close(4001, "replaced"); } catch { /* already closed */ }
        }
      }
      replaced = [...this.pending.values()];
      this.pending.clear();
      this.state.lastHeartbeat = new Date().toISOString();
      this.dirty = true;
      response = new Response(null, { status: 101, webSocket: client });
    });
    this.send(server, { type: "heartbeat" });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    for (const pending of replaced) {
      clearTimeout(pending.timer);
      pending.reject(relayError(409, "link_replaced", "The machine reconnected"));
    }
    return response;
  }

  async mcp(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...mcpHeaders(this.env, request), allow: "POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, x-room-id, x-machine-slot" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: mcpHeaders(this.env, request) });
    if (request.method !== "POST") throw relayError(405, "method_not_allowed", "Send POST with a JSON-RPC body");
    const { value } = await readJson(request, MAX_CALL_BYTES, "Tool call payload");
    const parsed = parseRpc(value);
    if (parsed.error) return json(200, parsed.error, mcpHeaders(this.env, request));
    if (parsed.notification && parsed.method === "notifications/initialized") {
      await this.requireCaller(request, { needLease: false });
      return new Response(null, { status: 202, headers: mcpHeaders(this.env, request) });
    }
    if (parsed.method === "ping") {
      await this.requireCaller(request, { needLease: false });
      return json(200, rpcResult(parsed.id, {}).body, mcpHeaders(this.env, request));
    }
    if (parsed.method === "initialize") {
      await this.requireCaller(request, { needLease: false });
      const result = initializeResult(parsed.id, parsed.params);
      return json(result.status, result.body, { ...mcpHeaders(this.env, request), ...(result.headers ?? {}) });
    }
    if (parsed.method === "tools/list") {
      await this.requireCaller(request, { needLease: false });
      return json(200, rpcResult(parsed.id, { tools: listedTools() }).body, mcpHeaders(this.env, request));
    }
    if (parsed.method === "tools/call") {
      const { name, args } = requireToolName(parsed.params);
      const slot = request.headers.get("x-machine-slot");
      const envelope = await this.invoke(request, name, args, slot);
      return json(200, rpcResult(parsed.id, envelope).body, mcpHeaders(this.env, request));
    }
    return json(200, rpcError(parsed.id, -32601, "Method not found").body, mcpHeaders(this.env, request));
  }

  async call(request) {
    if (request.method !== "POST") throw relayError(405, "method_not_allowed", "Use POST");
    const { value } = await readJson(request, MAX_CALL_BYTES, "Tool call payload");
    if (typeof value.tool !== "string" || value.tool.length === 0) throw relayError(422, "invalid_call", "Name the tool");
    const args = value.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw relayError(422, "invalid_call", "arguments must be an object");
    const slot = typeof value.slot === "string" ? value.slot : request.headers.get("x-machine-slot");
    return json(200, await this.invoke(request, value.tool, args, slot));
  }

  async requireCaller(request, options) {
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      this.dirty = true;
      await authorize(this.env, this.state, request, { ...options, tool: null, now: Date.now() });
    });
  }

  async invoke(request, tool, args, slot) {
    let waiter = null;
    let socket = null;
    let frame = null;
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      this.dirty = true;
      const auth = await authorize(this.env, this.state, request, {
        needLease: true, slotHint: slot || null, tool, now: Date.now(),
      });
      const lease = auth.lease;
      if (!toolAllowed(tool)) throw relayError(403, "tool_not_allowed", `${tool} is not an allowed machine tool`);
      const caller = {
        identityId: lease.holderIdentity,
        claimId: lease.claimId,
        slot: lease.slot,
        verified: true,
      };
      if (caller.verified !== true || typeof caller.identityId !== "string" || typeof caller.claimId !== "string" || !isSlot(caller.slot)) {
        throw relayError(403, "tool_not_allowed", "A verified lease is required");
      }
      socket = this.daemon();
      if (!socket) throw relayError(503, "machine_offline", "The machine is not linked");
      const id = crypto.randomUUID();
      frame = JSON.stringify({
        type: "call",
        id,
        tool,
        args,
        caller,
      });
      if (new TextEncoder().encode(frame).byteLength > MAX_CALL_BYTES) {
        throw relayError(413, "payload_too_large", `Tool call payload exceeds ${MAX_CALL_BYTES} bytes`);
      }
      waiter = this.track(id);
    });
    try { socket.send(frame); }
    catch {
      clearTimeout(waiter.timer);
      this.pending.delete(waiter.id);
      throw relayError(503, "machine_offline", "The machine is not linked");
    }
    return toolEnvelope(await waiter.promise);
  }

  track(id) {
    let resolve;
    let reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(relayError(504, "call_timeout", "The machine did not answer in time"));
    }, CALL_TIMEOUT_MS);
    const pending = { id, resolve, reject, timer, promise };
    this.pending.set(id, pending);
    return pending;
  }

  // A captured signed control request verifies again until its timestamp
  // ages out of the HMAC skew window. Refuse a signature this machine
  // already honored. Runs inside exclusive(), so check-and-mark is atomic.
  // The replay memory is anchored on the request's own timestamp (already
  // format-checked by verifyLinkSignature above): pruning on receipt time
  // would forget a future-dated signature while it still verifies.
  rejectReplayedControl(request, nowSec) {
    const signature = (request.headers.get("x-relay-signature") ?? "").toLowerCase();
    const stampSec = Number(request.headers.get("x-relay-timestamp") ?? "");
    this.state.replayedControls = assertFreshControlSignature(
      this.state.replayedControls, signature, nowSec, HMAC_SKEW_SEC + 60, stampSec);
    this.dirty = true;
  }

  async halt(request) {
    const { value, raw } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let cancels = [];
    let socket = null;
    let notice = null;
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      await verifyLinkSignature(this.env.RELAY_LINK_SECRET, request, raw, Math.floor(Date.now() / 1000));
      this.rejectReplayedControl(request, Math.floor(Date.now() / 1000));
      const nextEpoch = nextHaltEpoch(value, this.state);
      this.applyControl(value);
      this.state.haltEpoch = nextEpoch;
      this.state.halted = true;
      this.state.pausedUntil = null;
      this.state.activeLease = null;
      this.state.leases = {};
      this.dirty = true;
      cancels = [...this.pending.values()];
      this.pending.clear();
      socket = this.daemon();
      if (socket) notice = { type: "halt", epoch: this.state.haltEpoch };
    });
    if (notice) this.send(socket, notice);
    for (const pending of cancels) {
      clearTimeout(pending.timer);
      pending.reject(relayError(409, "halted", "The machine was halted"));
    }
    return json(200, { halted: true, haltEpoch: this.state.haltEpoch });
  }

  async resume(request) {
    const { value, raw } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let socket = null;
    let notice = null;
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      await verifyLinkSignature(this.env.RELAY_LINK_SECRET, request, raw, Math.floor(Date.now() / 1000));
      this.rejectReplayedControl(request, Math.floor(Date.now() / 1000));
      this.applyControl(value);
      this.state.halted = false;
      this.state.pausedUntil = null;
      this.dirty = true;
      socket = this.daemon();
      if (socket) notice = { type: "resume" };
    });
    if (notice) this.send(socket, notice);
    return json(200, { halted: false, haltEpoch: this.state.haltEpoch });
  }

  async pause(request) {
    const { value, raw } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let socket = null;
    let notice = null;
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      await verifyLinkSignature(this.env.RELAY_LINK_SECRET, request, raw, Math.floor(Date.now() / 1000));
      this.rejectReplayedControl(request, Math.floor(Date.now() / 1000));
      if (!isPauseMinutes(value.minutes)) {
        throw relayError(422, "invalid_pause", `minutes must be an integer from 1 to ${MAX_PAUSE_MINUTES}`);
      }
      this.state.pausedUntil = Date.now() + value.minutes * 60 * 1000;
      this.dirty = true;
      socket = this.daemon();
      if (socket) notice = { type: "pause", minutes: value.minutes };
    });
    if (notice) this.send(socket, notice);
    return json(200, { paused: true, minutes: value.minutes });
  }

  async bye(request) {
    const { raw } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let socket = null;
    let notice = null;
    let cancels = [];
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      await verifyLinkSignature(this.env.RELAY_LINK_SECRET, request, raw, Math.floor(Date.now() / 1000));
      this.rejectReplayedControl(request, Math.floor(Date.now() / 1000));
      this.dirty = true;
      cancels = [...this.pending.values()];
      this.pending.clear();
      socket = this.daemon();
      if (socket) notice = { type: "bye" };
    });
    if (notice) this.send(socket, notice);
    if (socket) {
      try { socket.close(1000, "bye"); } catch { /* already closed */ }
    }
    for (const pending of cancels) {
      clearTimeout(pending.timer);
      pending.reject(relayError(503, "machine_offline", "The machine link closed"));
    }
    return json(200, { bye: true });
  }

  applyControl(value) {
    if (value.resourceId !== undefined && value.resourceId !== null) {
      if (!isResourceId(value.resourceId)) throw relayError(422, "invalid_resource", "resourceId must be a short id");
      this.state.resourceId = value.resourceId;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const item of Array.isArray(value.revoke) ? value.revoke : []) {
      if (!item || typeof item.jti !== "string" || item.jti.length < 1 || item.jti.length > 128) continue;
      const exp = Number.isFinite(item.exp) ? item.exp : nowSec + 15 * 60;
      this.state.revoked = [...(this.state.revoked ?? []).filter(row => row.jti !== item.jti), { jti: item.jti, exp }];
    }
  }

  async status(request) {
    if (request.method !== "GET" && request.method !== "HEAD") throw relayError(405, "method_not_allowed", "Use GET");
    const body = await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      const token = request.headers.get("x-machine-token") || (/^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
      const machineAuthed = this.state.tokenHash && timingEqual(await sha256Hex(token), this.state.tokenHash);
      const adminAuthed = this.env.RELAY_ADMIN_TOKEN && timingEqual(await sha256Hex(token), await sha256Hex(this.env.RELAY_ADMIN_TOKEN));
      if (!machineAuthed && !adminAuthed) {
        this.dirty = true;
        await authorize(this.env, this.state, request, { needLease: false, slotHint: null, tool: null, now: Date.now() });
      }
      const lease = this.state.activeLease;
      return {
        machineId: this.state.machineId,
        label: this.state.label,
        online: Boolean(this.daemon()),
        halted: this.state.halted,
        haltEpoch: this.state.haltEpoch,
        lastHeartbeat: this.state.lastHeartbeat,
        toolCount: listedTools().length,
        rooms: this.state.rooms,
        ownerMemberId: this.state.ownerMemberId,
        resourceId: this.state.resourceId,
        lease: lease ? {
          claimId: lease.claimId, slot: lease.slot, holder: lease.holderName, expiresAt: lease.expiresAt, roomId: lease.roomId,
        } : null,
      };
    });
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    return json(200, body);
  }

  async disarmHeartbeat() {
    try { await this.ctx.storage.deleteAlarm(); } catch { /* no alarm was set */ }
  }
}

function usableSocket(socket) {
  if (!socket) return false;
  return socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED;
}

function nextHaltEpoch(value, state) {
  if (value.epoch === undefined || value.epoch === null) return state.haltEpoch + 1;
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) throw relayError(422, "invalid_epoch", "epoch must be a non-negative integer");
  if (value.epoch < state.haltEpoch) throw relayError(409, "stale_halt", "The halt epoch is older than the machine");
  if (value.epoch === state.haltEpoch) return state.halted ? state.haltEpoch : state.haltEpoch + 1;
  return value.epoch;
}
