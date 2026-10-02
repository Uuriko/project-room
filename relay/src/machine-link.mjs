// One Durable Object per machine. It keeps the daemon's outbound WebSocket,
// the enroll verifier hash, haltEpoch, and the lease it last checked.
// Hibernation holds the socket; in-flight calls live only while this
// isolate is awake, and a halt rejects them before the call timeout.

import { DurableObject } from "cloudflare:workers";
import { authorize } from "./auth.mjs";
import { bytesToB64url, sha256Hex, timingEqual } from "./bytes.mjs";
import { RelayError, relayError } from "./errors.mjs";
import { verifyLinkSignature } from "./hmac.mjs";
import { errorResponse, json, readJson } from "./http.mjs";
import { initializeResult, parseRpc, requireToolName, rpcError, rpcResult, toolEnvelope } from "./mcp.mjs";
import { redact } from "./redact.mjs";
import {
  CALL_TIMEOUT_MS, MAX_CALL_BYTES, MAX_SMALL_BYTES, PROTOCOL, filterTools, isResourceId, toolAllowed,
} from "./protocol.mjs";

const MCP_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id, www-authenticate",
});

function emptyState(machineId) {
  return {
    machineId,
    label: "",
    rooms: [],
    ownerMemberId: "",
    resourceId: null,
    tokenHash: null,
    enroll: null,
    haltEpoch: 0,
    halted: false,
    lastHeartbeat: null,
    tools: [],
    activeLease: null,
    revoked: [],
    identityCache: [],
    decisionCache: [],
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
      : /^\/v0\/machines\/[^/]+\/(link|mcp|call|halt|resume|status)$/.exec(url.pathname)?.[1];
    try {
      if (route === "mint") return await this.mint(request);
      if (route === "enroll") return await this.enroll(request);
      if (route === "expire-enroll") return await this.expireEnroll();
      if (route === "link") return await this.link(request);
      if (route === "mcp") return await this.mcp(request);
      if (route === "call") return await this.call(request);
      if (route === "halt") return await this.halt(request);
      if (route === "resume") return await this.resume(request);
      if (route === "status") return await this.status(request);
      return json(404, { error: { code: "not_found", message: "Not found" } });
    } catch (error) {
      if (!(error instanceof RelayError)) console.error(JSON.stringify(redact({ where: "machine", message: String(error?.message ?? error) })));
      const headers = route === "mcp" ? MCP_HEADERS : {};
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

  async webSocketMessage(ws, message) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > MAX_CALL_BYTES) {
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
    await this.exclusive(() => {
      if (!this.state) return;
      if (msg.type === "hello") this.state.tools = filterTools(msg.tools);
      this.state.lastHeartbeat = new Date().toISOString();
      this.dirty = true;
      if (msg.type === "hello") this.send(ws, { type: "welcome", machineId: this.state.machineId, haltEpoch: this.state.haltEpoch, protocol: PROTOCOL, halted: this.state.halted });
    });
  }

  async webSocketClose(ws) {
    if (this.live === ws) this.live = null;
  }

  async webSocketError(ws) {
    if (this.live === ws) this.live = null;
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
      this.state.rooms = value.rooms;
      this.state.ownerMemberId = value.ownerMemberId;
      this.state.enroll = { codeHash: value.codeHash, expiresAt: value.expiresAt, used: false };
      this.dirty = true;
    });
    return json(201, { machineId: value.machineId, expiresAt: value.expiresAt });
  }

  async enroll(request) {
    const { value } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let issued = null;
    await this.exclusive(async () => {
      if (!this.state?.enroll) throw relayError(401, "enroll_code_invalid", "The enroll code was refused");
      const hash = await sha256Hex(value.verifier);
      if (!timingEqual(hash, this.state.enroll.codeHash ?? "")) throw relayError(401, "enroll_code_invalid", "The enroll code was refused");
      if (this.state.enroll.used) throw relayError(401, "enroll_code_used", "The enroll code was already used");
      if (Date.parse(this.state.enroll.expiresAt) <= Date.now()) throw relayError(401, "enroll_code_expired", "The enroll code has expired");
      const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
      this.state.tokenHash = await sha256Hex(token);
      this.state.enroll = { codeHash: this.state.enroll.codeHash, expiresAt: this.state.enroll.expiresAt, used: true };
      this.dirty = true;
      issued = token;
    });
    return json(200, { machineId: this.state.machineId, machineToken: issued });
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
    const token = request.headers.get("x-machine-token") || (/^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
    let replaced = [];
    let response = null;
    await this.exclusive(async () => {
      if (!this.state?.tokenHash) throw relayError(401, "unauthenticated", "The machine token was refused");
      const hash = await sha256Hex(token);
      if (!timingEqual(hash, this.state.tokenHash)) throw relayError(401, "unauthenticated", "The machine token was refused");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      this.live = server;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== server) {
          try { socket.close(4001, "replaced"); } catch { /* already closed */ }
        }
      }
      replaced = [...this.pending.values()];
      this.pending.clear();
      this.state.lastHeartbeat = new Date().toISOString();
      this.dirty = true;
      this.send(server, { type: "welcome", machineId: this.state.machineId, haltEpoch: this.state.haltEpoch, protocol: PROTOCOL, halted: this.state.halted });
      response = new Response(null, { status: 101, webSocket: client });
    });
    for (const pending of replaced) {
      clearTimeout(pending.timer);
      pending.reject(relayError(409, "link_replaced", "The machine reconnected"));
    }
    return response;
  }

  async mcp(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...MCP_HEADERS, allow: "POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, x-room-id, x-machine-slot" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: MCP_HEADERS });
    if (request.method !== "POST") throw relayError(405, "method_not_allowed", "Send POST with a JSON-RPC body");
    const { value } = await readJson(request, MAX_CALL_BYTES, "Tool call payload");
    const parsed = parseRpc(value);
    if (parsed.error) return json(200, parsed.error, MCP_HEADERS);
    if (parsed.notification && parsed.method === "notifications/initialized") {
      await this.requireCaller(request, { needLease: false });
      return new Response(null, { status: 202, headers: MCP_HEADERS });
    }
    if (parsed.method === "ping") {
      await this.requireCaller(request, { needLease: false });
      return json(200, rpcResult(parsed.id, {}).body, MCP_HEADERS);
    }
    if (parsed.method === "initialize") {
      await this.requireCaller(request, { needLease: false });
      const result = initializeResult(parsed.id, parsed.params);
      return json(result.status, result.body, { ...MCP_HEADERS, ...(result.headers ?? {}) });
    }
    if (parsed.method === "tools/list") {
      await this.requireCaller(request, { needLease: false });
      const tools = await this.exclusive(() => this.state?.tools ?? []);
      return json(200, rpcResult(parsed.id, { tools }).body, MCP_HEADERS);
    }
    if (parsed.method === "tools/call") {
      const { name, args } = requireToolName(parsed.params);
      const slot = request.headers.get("x-machine-slot");
      const envelope = await this.invoke(request, name, args, slot);
      return json(200, rpcResult(parsed.id, envelope).body, MCP_HEADERS);
    }
    return json(200, rpcError(parsed.id, -32601, "Method not found").body, MCP_HEADERS);
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
      if (!toolAllowed(tool) || !this.state.tools.some(item => item.name === tool)) {
        throw relayError(404, "tool_unknown", `${tool} is not available on this machine`);
      }
      socket = this.daemon();
      if (!socket) throw relayError(503, "machine_offline", "The machine is not linked");
      const id = crypto.randomUUID();
      frame = JSON.stringify({
        type: "call",
        id,
        tool,
        arguments: args,
        lease: {
          claim: lease.claimId,
          slot: lease.slot,
          holder: lease.holderIdentity,
          room: lease.roomId,
          exp: lease.expiresAt ? Math.floor(Date.parse(lease.expiresAt) / 1000) : null,
          caps: lease.caps ?? [],
        },
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

  async halt(request) {
    const { value, raw } = await readJson(request, MAX_SMALL_BYTES, "Request body");
    let cancels = [];
    let socket = null;
    let notice = null;
    await this.exclusive(async () => {
      if (!this.state) throw relayError(404, "machine_unknown", "No such machine");
      await verifyLinkSignature(this.env.RELAY_LINK_SECRET, request, raw, Math.floor(Date.now() / 1000));
      const nextEpoch = nextHaltEpoch(value, this.state);
      this.applyControl(value);
      this.state.haltEpoch = nextEpoch;
      this.state.halted = true;
      this.state.activeLease = null;
      this.dirty = true;
      cancels = [...this.pending.values()];
      this.pending.clear();
      socket = this.daemon();
      if (socket) notice = { type: "halt", haltEpoch: this.state.haltEpoch, reason: reasonOf(value) };
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
      this.applyControl(value);
      this.state.halted = false;
      this.dirty = true;
      socket = this.daemon();
      if (socket) notice = { type: "resume", haltEpoch: this.state.haltEpoch };
    });
    if (notice) this.send(socket, notice);
    return json(200, { halted: false, haltEpoch: this.state.haltEpoch });
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
        toolCount: this.state.tools.length,
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
}

function usableSocket(socket) {
  if (!socket) return false;
  return socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED;
}

function reasonOf(value) {
  return typeof value.reason === "string" && value.reason.length <= 80 ? value.reason : "halt";
}

function nextHaltEpoch(value, state) {
  if (value.epoch === undefined || value.epoch === null) return state.haltEpoch + 1;
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) throw relayError(422, "invalid_epoch", "epoch must be a non-negative integer");
  if (value.epoch < state.haltEpoch) throw relayError(409, "stale_halt", "The halt epoch is older than the machine");
  if (value.epoch === state.haltEpoch) return state.halted ? state.haltEpoch : state.haltEpoch + 1;
  return value.epoch;
}
