// Workerd harness for the relay Worker. Room is a real HTTP server on the
// outbound side: it answers the membership and board routes with claim
// objects built by server/work-claims.mjs. The daemon is a real WebSocket.

import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { claimWork, createWork, updateWork } from "../../server/work-claims.mjs";

const ROOM_ORIGIN = "https://room.test";
const RELAY_ORIGIN = "https://relay.test";

let bundlePromise;

function bundleWorker() {
  bundlePromise ??= build({
    entryPoints: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    keepNames: true,
    external: ["cloudflare:workers", "node:*"],
  });
  return bundlePromise;
}

export function secret(prefix) {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function claimOnSlot({ id, owner, machineId, slot, at, leaseHours = 2, kind = "work" }) {
  const files = [`resource/${machineId}/${slot}`];
  const created = createWork({
    id, title: id, files, kind, revision: kind === "work" ? null : "rev-1",
  }, { now: at, agentId: owner });
  return claimWork(created, owner, { now: at, leaseHours, files });
}

export function finishClaim(item, owner, at) {
  const working = updateWork(item, owner, { state: "in_progress", now: at });
  return updateWork(working, owner, { state: "done", now: at });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function createRoom() {
  const people = new Map();
  const boards = new Map();
  const fetches = [];
  return {
    fetches,
    person({ token, memberId, identityId, handle, rooms }) {
      people.set(token, { memberId, identityId, handle, rooms: new Set(rooms) });
    },
    claims(roomId, claims) {
      boards.set(roomId, claims);
    },
    async handle(request) {
      const url = new URL(request.url);
      fetches.push(`${request.method} ${url.pathname}`);
      const token = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      const person = people.get(token);
      if (!person) return jsonResponse(401, { error: { code: -32001, message: "unauthorized" } });
      if (url.pathname === "/mcp") return membership(request, person);
      const roomId = url.pathname.split("/")[3];
      if (!person.rooms.has(roomId)) return jsonResponse(403, { error: { code: "not_member", message: "no" } });
      if (url.pathname.endsWith("/activation-pack")) return jsonResponse(200, pack(roomId, people));
      if (url.pathname.endsWith("/work-claims")) return jsonResponse(200, page(url, boards.get(roomId) ?? [], roomId));
      throw new Error(`unexpected room path ${url.pathname}`);
    },
  };
}

async function membership(request, person) {
  const body = await request.json();
  const roomId = body?.params?.arguments?.roomId;
  if (body?.params?.name !== "room_check_access" || !person.rooms.has(roomId)) {
    return jsonResponse(403, { error: { code: "not_member", message: "no" } });
  }
  return jsonResponse(200, {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: {
      content: [{ type: "text", text: "credential_accepted" }],
      structuredContent: {
        status: "credential_accepted",
        memberId: person.memberId,
        identityId: person.identityId,
        kind: "agent",
        permissions: ["read"],
      },
    },
  });
}

function pack(roomId, people) {
  const members = [];
  for (const person of people.values()) {
    if (!person.rooms.has(roomId)) continue;
    members.push({
      id: person.memberId,
      handle: person.handle,
      identityId: person.identityId,
      kind: "agent",
      permissions: ["read"],
    });
  }
  return { room: { slug: roomId, title: roomId, state: "active" }, members };
}

function page(url, claims, roomId) {
  const cursor = url.searchParams.get("cursor");
  if (!cursor && claims.length > 1) {
    return { roomId, swept: false, claims: claims.slice(0, -1), hasMore: true, nextCursor: "p2" };
  }
  const visible = cursor ? claims.slice(-1) : claims;
  return { roomId, swept: false, claims: visible, hasMore: false, nextCursor: null };
}

export async function startRelay({ passthrough = false, lockCacheMs = "0", secrets = true, room = createRoom() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const adminToken = secret("adm");
  const linkSecret = secret("lnk");
  const jwk = publicKey.export({ format: "jwk" });
  const bundled = await bundleWorker();
  const bindings = {
    ROOM_ORIGIN,
    RELAY_PHASE0_PASSTHROUGH: passthrough ? "1" : "0",
    RELAY_LOCK_CACHE_MS: lockCacheMs,
  };
  if (secrets) {
    bindings.RELAY_ADMIN_TOKEN = adminToken;
    bindings.RELAY_LINK_SECRET = linkSecret;
    bindings.ROOM_RESOURCE_LEASE_PUBLIC_JWK = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  }
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MACHINE: { className: "MachineLink", useSQLite: true } },
    bindings,
    outboundService: request => {
      const url = new URL(request.url);
      if (url.origin !== ROOM_ORIGIN) throw new Error(`unexpected fetch ${request.method} ${request.url}`);
      return room.handle(request);
    },
  });
  return {
    mf, room, adminToken, linkSecret, privateKey, publicJwk: jwk,
    origin: RELAY_ORIGIN,
    roomOrigin: ROOM_ORIGIN,
    async dispose() { await mf.dispose(); },
  };
}

export async function readBody(response) {
  const text = await response.text();
  if (!text) return { status: response.status, body: null, headers: response.headers };
  try { return { status: response.status, body: JSON.parse(text), headers: response.headers }; }
  catch { return { status: response.status, body: text, headers: response.headers }; }
}

export function relayFetch(ctx, path, { method = "GET", json, raw, headers = {} } = {}) {
  const body = raw ?? (json === undefined ? undefined : JSON.stringify(json));
  return ctx.mf.dispatchFetch(ctx.origin + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}

export async function mint(ctx, fields) {
  const response = await relayFetch(ctx, "/admin/enroll-codes", {
    method: "POST",
    json: fields,
    headers: { authorization: `Bearer ${ctx.adminToken}` },
  });
  return readBody(response);
}

export async function enroll(ctx, code) {
  const response = await relayFetch(ctx, "/v0/enroll", { method: "POST", json: { code } });
  return readBody(response);
}

export async function expireCode(ctx, machineId) {
  const response = await relayFetch(ctx, `/admin/enroll-codes/${machineId}/expire`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.adminToken}` },
  });
  return readBody(response);
}

export async function machineStatus(ctx, machineId, token = ctx.adminToken) {
  const response = await relayFetch(ctx, `/v0/machines/${machineId}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return readBody(response);
}

export async function postCall(ctx, machineId, payload, headers = {}) {
  const response = await relayFetch(ctx, `/v0/machines/${machineId}/call`, {
    method: "POST",
    json: payload,
    headers,
  });
  return readBody(response);
}

export async function postRpc(ctx, machineId, message, headers = {}) {
  const response = await relayFetch(ctx, `/v0/machines/${machineId}/mcp`, {
    method: "POST",
    json: { jsonrpc: "2.0", id: "1", ...message },
    headers: { accept: "application/json, text/event-stream", ...headers },
  });
  return readBody(response);
}

export function signControl(ctx, payload) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", ctx.linkSecret).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, timestamp, signature };
}

export async function control(ctx, machineId, action, payload) {
  const signed = signControl(ctx, payload);
  const response = await relayFetch(ctx, `/v0/machines/${machineId}/${action}`, {
    method: "POST",
    raw: signed.raw,
    headers: {
      "x-relay-timestamp": signed.timestamp,
      "x-relay-signature": signed.signature,
    },
  });
  return readBody(response);
}

export function leaseToken(ctx, claims) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${body}`;
  const signature = sign(null, Buffer.from(input), ctx.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

export async function linkDaemon(ctx, machineId, token, { label = "Desk", protocol = 1, version = "0.1.0", answer = null } = {}) {
  const response = await ctx.mf.dispatchFetch(`${ctx.origin}/v0/machines/link`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
  });
  if (response.status !== 101) {
    const failed = await readBody(response);
    throw new Error(`link failed ${failed.status} ${JSON.stringify(failed.body)}`);
  }
  const ws = response.webSocket;
  if (!ws) throw new Error("link returned no websocket");
  const seen = [];
  let closed = null;
  ws.addEventListener("message", async event => {
    const msg = JSON.parse(await frameText(event.data));
    seen.push(msg);
    if (msg.type === "call" && answer) {
      const outcome = await answer(msg);
      if (!outcome) return;
      ws.send(JSON.stringify({
        type: "result",
        id: msg.id,
        ok: outcome.ok !== false,
        ...(outcome.ok === false ? { error: outcome.error } : { result: outcome.result ?? null }),
      }));
    }
  });
  ws.addEventListener("close", event => {
    closed = { code: event.code, reason: String(event.reason ?? "") };
  });
  ws.accept();
  async function expectFrame(type, timeout = 2000) {
    const start = Date.now();
    for (;;) {
      const index = seen.findIndex(msg => msg.type === type);
      if (index >= 0) return seen.splice(index, 1)[0];
      if (Date.now() - start > timeout) throw new Error(`no ${type} frame; saw ${seen.map(msg => msg.type).join(",") || "nothing"}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await expectFrame("heartbeat");
  ws.send(JSON.stringify({ type: "hello", protocol, machineId, label, version }));
  return {
    ws,
    seen,
    expectFrame,
    closeInfo() { return closed; },
  };
}
