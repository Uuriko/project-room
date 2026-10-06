// Relay Worker. Room stays the control plane. This worker only carries
// tool calls for a machine whose daemon dialed out, and it refuses any
// call that a live lease does not back. Passthrough auth is off unless
// RELAY_PHASE0_PASSTHROUGH is exactly "1".

import { randomB64url, randomHex, sha256Hex, timingEqual } from "./bytes.mjs";
import { RelayError, relayError } from "./errors.mjs";
import { errorResponse, json, readJson } from "./http.mjs";
import { MachineLink } from "./machine-link.mjs";
import { log, recentLogs } from "./redact.mjs";
import {
  ENROLL_TTL_MS, MAX_SMALL_BYTES, SERVER_NAME, challengeHeader, isInviteCode, isLabel, isMachineId, isMemberId, isRoomId, roomOriginOf,
} from "./protocol.mjs";

export { MachineLink };

const MACHINE_ROUTE = /^\/v0\/machines\/([^/]+)\/(link|mcp|call|halt|pause|resume|bye|status)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const response = await route(request, env, url);
      log({ method: request.method, path: url.pathname, status: response.status, authorization: request.headers.get("authorization") });
      return response;
    } catch (error) {
      const response = errorResponse(error, authenticateHeader(error, request));
      const aliased = url.pathname === "/enroll" ? deprecatedResponse(response, { deprecation: "true" }) : response;
      log({
        method: request.method,
        path: url.pathname,
        status: response.status,
        authorization: request.headers.get("authorization"),
        error: error instanceof RelayError ? error.code : "internal",
      });
      if (!(error instanceof RelayError)) console.error(JSON.stringify({ message: "relay request failed" }));
      return aliased;
    }
  },
};

async function route(request, env, url) {
  if (url.pathname === "/healthz") return healthz(request, env);
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
    return metadata(request, env, url);
  }
  if (url.pathname === "/admin/enroll-codes" && request.method === "POST") return mintEnroll(request, env);
  const expire = /^\/admin\/enroll-codes\/([^/]+)\/expire$/.exec(url.pathname);
  if (expire && request.method === "POST") return expireEnroll(request, env, expire[1]);
  if (url.pathname === "/admin/logs" && request.method === "GET") return adminLogs(request, env);
  if ((url.pathname === "/v0/enroll" || url.pathname === "/enroll") && request.method === "POST") {
    return enroll(request, env, { deprecated: url.pathname === "/enroll" });
  }
  if (url.pathname === "/v0/machines/link") return linkByToken(request, env, url);
  const match = MACHINE_ROUTE.exec(url.pathname);
  if (!match) throw relayError(404, "not_found", "Not found");
  if (!isMachineId(match[1])) throw relayError(404, "not_found", "Not found");
  const response = await machine(env, match[1]).fetch(request);
  if (response.status !== 401 || response.headers.get("www-authenticate")) return response;
  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challengeHeader(request, match[1]));
  return new Response(response.body, { status: 401, headers });
}

function healthz(request, env) {
  // L1: no unauthenticated recon — which secrets are unset stays behind
  // admin auth. Liveness only.
  const body = { status: "ok", service: SERVER_NAME };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  if (request.method !== "GET") throw relayError(405, "method_not_allowed", "Use GET");
  return json(200, body);
}

function metadata(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") throw relayError(405, "method_not_allowed", "Use GET");
  const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length);
  const resourcePath = suffix.startsWith("/") ? suffix : "/mcp";
  const body = {
    resource: `${url.origin}${resourcePath}`,
    authorization_servers: [(env.ROOM_ORIGIN || "https://room.trydemigod.com").replace(/\/$/, "")],
    bearer_methods_supported: ["header"],
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  return json(200, body);
}

async function mintEnroll(request, env) {
  await requireAdmin(env, request);
  const { value } = await readJson(request, MAX_SMALL_BYTES, "Request body");
  if (!isLabel(value.label)) throw relayError(422, "invalid_enroll", "label must be 1..80 characters without control characters");
  const { roomId, rooms } = enrollRooms(value);
  if (!isMemberId(value.ownerMemberId)) throw relayError(422, "invalid_enroll", "ownerMemberId must be a short id");
  if (!isInviteCode(value.inviteCode)) throw relayError(422, "invalid_enroll", "inviteCode must be an operator-minted Room code");
  if (value.profile !== undefined && value.profile !== "contribute") {
    throw relayError(422, "invalid_enroll", "The invite profile must be contribute");
  }
  if (value.displayName !== undefined && !isLabel(value.displayName)) {
    throw relayError(422, "invalid_enroll", "displayName must be 1..80 characters without control characters");
  }
  const roomOrigin = enrollOrigin(value);
  const machineId = `mch_${randomHex(8)}`;
  const verifier = randomB64url(32);
  const expiresAt = new Date(Date.now() + ENROLL_TTL_MS).toISOString();
  const response = await machine(env, machineId).fetch(new Request("https://machine.internal/mint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId,
      label: value.label,
      roomId,
      rooms,
      ownerMemberId: value.ownerMemberId,
      inviteCode: value.inviteCode,
      displayName: value.displayName ?? null,
      roomOrigin,
      codeHash: await sha256Hex(verifier),
      expiresAt,
      // W5-M5: forward the per-machine passthrough opt-in and caps.
      passthroughOptIn: value.passthroughOptIn === true,
      passthroughCaps: Array.isArray(value.passthroughCaps) ? value.passthroughCaps : null,
    }),
  }));
  if (!response.ok) return response;
  await response.arrayBuffer();
  return json(201, {
    code: `${machineId}.${verifier}`,
    machineId,
    expiresAt,
    label: value.label,
    roomId,
    ownerMemberId: value.ownerMemberId,
    inviteCode: value.inviteCode,
    ...(value.displayName ? { displayName: value.displayName } : {}),
    ...(roomOrigin ? { roomOrigin } : {}),
  });
}

async function enroll(request, env, { deprecated = false } = {}) {
  const finish = response => (deprecated ? deprecatedResponse(response) : response);
  let value;
  try {
    ({ value } = await readJson(request, MAX_SMALL_BYTES, "Request body"));
  } catch (error) {
    if (error instanceof RelayError && (error.code === "invalid_json" || error.code === "json_required")) {
      return finish(json(401, { error: "code_invalid" }));
    }
    throw error;
  }
  const parsed = parseCode(value.code);
  if (!parsed) return finish(json(401, { error: "code_invalid" }));
  const response = await machine(env, parsed.machineId).fetch(new Request("https://machine.internal/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verifier: parsed.verifier }),
  }));
  if (!response.ok) return finish(response);
  const issued = await response.json();
  return finish(json(200, publicEnroll(issued, request, env)));
}

function deprecatedResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("deprecation", "true");
  return new Response(response.body, { status: response.status, headers });
}

function enrollRooms(value) {
  if (Array.isArray(value.rooms)) {
    if (value.rooms.length < 1 || value.rooms.length > 8 || value.rooms.some(room => !isRoomId(room))) {
      throw relayError(422, "invalid_enroll", "rooms must list 1..8 room ids");
    }
    if (value.roomId !== undefined && value.roomId !== value.rooms[0]) {
      throw relayError(422, "invalid_enroll", "roomId must be the first room");
    }
    return { roomId: value.rooms[0], rooms: value.rooms };
  }
  if (!isRoomId(value.roomId)) throw relayError(422, "invalid_enroll", "roomId must be a short id");
  return { roomId: value.roomId, rooms: [value.roomId] };
}

function enrollOrigin(value) {
  if (value.roomOrigin === undefined || value.roomOrigin === null || value.roomOrigin === "") return "";
  const origin = roomOriginOf(value.roomOrigin);
  if (!origin) throw relayError(422, "invalid_enroll", "roomOrigin must be an http(s) origin");
  return origin;
}

function publicEnroll(issued, request, env) {
  const linkUrl = new URL(request.url);
  linkUrl.protocol = linkUrl.protocol === "https:" ? "wss:" : "ws:";
  linkUrl.pathname = "/v0/machines/link";
  linkUrl.search = "";
  linkUrl.hash = "";
  const body = {
    machineToken: issued.machineToken,
    machineId: issued.machineId,
    label: issued.label,
    roomId: issued.roomId,
    ownerMemberId: issued.ownerMemberId,
    inviteCode: issued.inviteCode,
    relayUrl: linkUrl.toString(),
  };
  if (typeof issued.displayName === "string" && issued.displayName) body.displayName = issued.displayName;
  const stored = typeof issued.roomOrigin === "string" ? issued.roomOrigin : "";
  const origin = stored || (typeof env.ROOM_ORIGIN === "string" ? env.ROOM_ORIGIN.replace(/\/$/, "") : "");
  if (origin) body.roomOrigin = origin;
  return body;
}

async function linkByToken(request, env, url) {
  if (url.searchParams.has("token") || url.searchParams.has("machineToken")) {
    throw relayError(401, "unauthenticated", "The machine token was refused");
  }
  const token = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const machineId = token.split(".")[0];
  if (!isMachineId(machineId)) throw relayError(401, "unauthenticated", "The machine token was refused");
  const response = await machine(env, machineId).fetch(request);
  if (response.status !== 401 || response.headers.get("www-authenticate")) return response;
  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challengeHeader(request, machineId));
  return new Response(response.body, { status: 401, headers });
}

async function expireEnroll(request, env, machineId) {
  await requireAdmin(env, request);
  if (!isMachineId(machineId)) throw relayError(404, "not_found", "Not found");
  return machine(env, machineId).fetch(new Request("https://machine.internal/expire-enroll", { method: "POST" }));
}

async function adminLogs(request, env) {
  await requireAdmin(env, request);
  return json(200, { logs: recentLogs() });
}

async function requireAdmin(env, request) {
  if (!env.RELAY_ADMIN_TOKEN) throw relayError(503, "relay_unconfigured", "RELAY_ADMIN_TOKEN is not set");
  const presented = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const [left, right] = await Promise.all([sha256Hex(presented), sha256Hex(env.RELAY_ADMIN_TOKEN)]);
  if (!timingEqual(left, right)) throw relayError(401, "unauthenticated", "The admin token was refused");
}

function parseCode(code) {
  if (typeof code !== "string") return null;
  const dot = code.indexOf(".");
  if (dot < 0) return null;
  const machineId = code.slice(0, dot);
  const verifier = code.slice(dot + 1);
  if (!isMachineId(machineId) || !/^[A-Za-z0-9_-]{20,128}$/.test(verifier)) return null;
  return { machineId, verifier };
}

function machine(env, machineId) {
  if (!env.MACHINE) throw relayError(503, "relay_unconfigured", "The machine Durable Object is not bound");
  return env.MACHINE.get(env.MACHINE.idFromName(machineId));
}

function authenticateHeader(error, request) {
  if (!(error instanceof RelayError) || error.status !== 401) return {};
  const match = MACHINE_ROUTE.exec(new URL(request.url).pathname);
  if (!match) return {};
  return { "www-authenticate": challengeHeader(request, match[1]) };
}
