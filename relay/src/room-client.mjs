// Phase 0 checks a Room bearer by calling Room's existing reads. The bearer
// is a request header and is never written to storage or logs.

import { relayError } from "./errors.mjs";

async function roomFetch(url, bearer, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw relayError(503, "room_unavailable", "Room did not answer");
  }
  return response;
}

async function readBody(response) {
  try { return await response.json(); }
  catch { return null; }
}

export async function fetchIdentity(origin, roomId, bearer) {
  const response = await roomFetch(new URL("/mcp", origin), bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name: "room_check_access", arguments: { roomId } },
    }),
  });
  const payload = await readBody(response);
  if (response.status === 401 || payload?.error?.code === -32001) {
    throw relayError(401, "unauthenticated", "The Room bearer was refused");
  }
  if (response.status === 403) throw relayError(403, "not_member", "That identity is not a member of this room");
  if (!response.ok) throw relayError(503, "room_unavailable", "Room did not answer the membership check");
  const access = payload?.result?.structuredContent;
  if (!access || typeof access.memberId !== "string" || typeof access.identityId !== "string") {
    throw relayError(403, "not_member", "That identity is not a member of this room");
  }
  return { memberId: access.memberId, identityId: access.identityId };
}

export async function fetchBoard(origin, roomId, bearer) {
  const [packResponse, claims] = await Promise.all([
    roomFetch(new URL(`/api/rooms/${encodeURIComponent(roomId)}/activation-pack`, origin), bearer),
    listClaims(origin, roomId, bearer),
  ]);
  const pack = packResponse.ok ? await readBody(packResponse) : null;
  const names = new Map();
  for (const member of pack?.members ?? []) {
    if (typeof member?.id === "string" && typeof member.handle === "string" && member.handle.length > 0) {
      names.set(member.id, member.handle);
    }
  }
  return { claims, names };
}

async function listClaims(origin, roomId, bearer) {
  const claims = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/work-claims`, origin);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await roomFetch(url, bearer);
    if (response.status === 401) throw relayError(401, "unauthenticated", "The Room bearer was refused");
    if (response.status === 403) throw relayError(403, "not_member", "That identity is not a member of this room");
    if (!response.ok) throw relayError(503, "room_unavailable", "Room did not answer the board read");
    const body = await readBody(response);
    if (!body || !Array.isArray(body.claims)) throw relayError(503, "room_unavailable", "Room returned an unreadable board");
    claims.push(...body.claims);
    if (!body.hasMore || typeof body.nextCursor !== "string" || body.nextCursor.length === 0) break;
    cursor = body.nextCursor;
  }
  return claims;
}
