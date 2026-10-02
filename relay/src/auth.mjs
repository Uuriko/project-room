import { sha256Hex } from "./bytes.mjs";
import { relayError } from "./errors.mjs";
import { verifyLeaseToken } from "./jws.mjs";
import { holdersForMachine } from "./lock.mjs";
import {
  IDENTITY_CACHE_MS, capsCover, isRoomId, isSlot, lockCacheMs, passthroughEnabled, toolAllowed,
} from "./protocol.mjs";
import { fetchBoard, fetchIdentity } from "./room-client.mjs";

function samePerson(identity, owner) {
  return owner === identity.memberId || owner === identity.identityId;
}

function publicLease(lease) {
  return {
    claimId: lease.claimId,
    slot: lease.slot,
    holderIdentity: lease.holderIdentity,
    holderName: lease.holderName,
    roomId: lease.roomId,
    expiresAt: lease.expiresAt,
    caps: lease.caps ?? null,
  };
}

export async function authorize(env, state, request, { needLease, slotHint, tool, now }) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  const presented = match?.[1] ?? "";
  if (!presented) {
    throw relayError(401, passthroughEnabled(env) ? "unauthenticated" : "lease_token_required",
      passthroughEnabled(env) ? "Send a Room bearer token" : "Send a Room lease token");
  }
  if (passthroughEnabled(env)) return authorizePassthrough(env, state, request, presented, { needLease, slotHint, tool, now });
  return authorizeLease(env, state, presented, { needLease, slotHint, tool, now });
}

async function authorizeLease(env, state, token, { needLease, slotHint, tool, now }) {
  const origin = (env.ROOM_ORIGIN || "https://room.trydemigod.com").replace(/\/$/, "");
  const claims = await verifyLeaseToken(env.ROOM_RESOURCE_LEASE_PUBLIC_JWK, token, now);
  if (claims.iss !== origin) throw relayError(401, "lease_token_rejected", "The lease token issuer was refused");
  const expectedAud = state.resourceId ? `relay:${state.resourceId}` : `relay:${state.machineId}`;
  if (claims.aud !== expectedAud) throw relayError(401, "lease_token_audience", "The lease token is for a different resource");
  if (!isSlot(claims.slot)) throw relayError(401, "lease_token_rejected", "The lease token slot is invalid");
  if (claims.epoch < state.haltEpoch) throw relayError(401, "stale_epoch", "The lease token is older than the latest halt");
  const nowSec = Math.floor(now / 1000);
  state.revoked = (state.revoked ?? []).filter(item => item.exp > nowSec);
  if ((state.revoked ?? []).some(item => item.jti === claims.jti)) {
    throw relayError(401, "lease_token_revoked", "The lease token was revoked");
  }
  if (state.halted && needLease) throw relayError(409, "halted", "The machine is halted");
  if (needLease && slotHint && slotHint !== claims.slot) throw relayError(422, "slot_mismatch", "The requested slot does not match the lease token");
  const active = liveLease(state, now);
  if (active && (active.slot !== claims.slot || active.claimId !== claims.claim)) {
    throw relayError(409, "slot_held", slotHeldMessage(active), {
      holder: active.holderName, expiresAt: active.expiresAt, claimId: active.claimId, slot: active.slot,
    });
  }
  const lease = {
    claimId: claims.claim,
    slot: claims.slot,
    holderIdentity: claims.sub,
    holderName: claims.sub,
    roomId: claims.room,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    caps: claims.caps,
  };
  if (needLease) state.activeLease = lease;
  if (needLease && tool) {
    if (!toolAllowed(tool)) throw relayError(403, "tool_not_allowed", `${tool} is not an allowed machine tool`);
    if (!capsCover(claims.caps, tool)) throw relayError(403, "capability_denied", `The lease does not cover ${tool}`);
  }
  return { identity: { memberId: claims.sub, identityId: claims.sub }, lease: publicLease(lease) };
}

async function authorizePassthrough(env, state, request, bearer, { needLease, slotHint, tool, now }) {
  const roomId = request.headers.get("x-room-id") || (state.rooms.length === 1 ? state.rooms[0] : "");
  if (!roomId) throw relayError(422, "room_required", "Name the room in X-Room-Id");
  if (!isRoomId(roomId) || !state.rooms.includes(roomId)) {
    throw relayError(403, "room_not_allowed", "This machine is not allowlisted for that room");
  }
  const origin = env.ROOM_ORIGIN;
  if (!origin) throw relayError(503, "relay_unconfigured", "ROOM_ORIGIN is not set");
  const hash = await sha256Hex(bearer);
  let identity = (state.identityCache ?? []).find(item => item.hash === hash && item.roomId === roomId && now - item.at < IDENTITY_CACHE_MS);
  if (!identity) {
    const fetched = await fetchIdentity(origin, roomId, bearer);
    identity = { hash, roomId, memberId: fetched.memberId, identityId: fetched.identityId, at: now };
    state.identityCache = [identity, ...(state.identityCache ?? []).filter(item => !(item.hash === hash && item.roomId === roomId))].slice(0, 32);
  }
  if (state.halted && needLease) throw relayError(409, "halted", "The machine is halted");
  if (!needLease) return { identity, lease: null };
  if (slotHint && !isSlot(slotHint)) throw relayError(422, "invalid_slot", "slot must be a short lowercase name");
  if (tool && !toolAllowed(tool)) throw relayError(403, "tool_not_allowed", `${tool} is not an allowed machine tool`);
  let decision = (state.decisionCache ?? []).find(item => item.roomId === roomId && now - item.at < lockCacheMs(env));
  if (!decision) {
    const board = await fetchBoard(origin, roomId, bearer);
    const winners = [];
    for (const [slot, claim] of holdersForMachine(board.claims, state.machineId, now)) {
      winners.push({
        slot,
        claimId: claim.id,
        owner: claim.owner,
        holderName: board.names.get(claim.owner) || claim.owner,
        expiresAt: claim.leaseExpiresAt ?? null,
        claimedAt: claim.claimedAt,
      });
    }
    decision = { roomId, at: now, winners };
    state.decisionCache = [decision, ...(state.decisionCache ?? []).filter(item => item.roomId !== roomId)].slice(0, 8);
  }
  const held = decision.winners.filter(item => samePerson(identity, item.owner));
  let slot = slotHint;
  if (!slot) {
    if (held.length === 1) slot = held[0].slot;
    else if (held.length === 0) throw relayError(409, "slot_free", "No active claim holds a slot on this machine for you");
    else throw relayError(422, "slot_required", "Name the slot in X-Machine-Slot");
  }
  const winner = decision.winners.find(item => item.slot === slot);
  if (!winner) throw relayError(409, "slot_free", `No active claim holds ${slot}`);
  if (!samePerson(identity, winner.owner)) {
    throw relayError(409, "slot_held", slotHeldMessage(winner), {
      holder: winner.holderName, expiresAt: winner.expiresAt, claimId: winner.claimId, slot: winner.slot,
    });
  }
  const lease = {
    claimId: winner.claimId,
    slot: winner.slot,
    holderIdentity: identity.identityId,
    holderName: winner.holderName,
    roomId,
    expiresAt: winner.expiresAt,
    caps: null,
  };
  state.activeLease = lease;
  return { identity, lease: publicLease(lease) };
}

function liveLease(state, now) {
  const lease = state.activeLease;
  if (!lease?.expiresAt) return null;
  const exp = Date.parse(lease.expiresAt);
  if (!Number.isFinite(exp) || exp <= now) return null;
  return lease;
}

function slotHeldMessage(lease) {
  const until = lease.expiresAt ? ` until ${lease.expiresAt}` : "";
  return `${lease.slot} is held by ${lease.holderName}${until}`;
}
