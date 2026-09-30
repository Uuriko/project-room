// Matchmaking P1 — HTTP routes (matchmaking-plan-2026-09-30.md §6/§16).
//
// Room-scoped handlers mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks — the
// same mounting pattern as server/bounty-escrow-routes.mjs:
//
//   POST /api/rooms/{roomId}/matchmaking/enter    — upsert seeker profile AND
//                                                   return matches (P1: the
//                                                   engine is not wired, so
//                                                   matches is [] with
//                                                   abstained:true and a
//                                                   plain-language reason)
//   GET  /api/rooms/{roomId}/matchmaking/matches  — personalized matches for
//                                 ?for=self        the caller (same P1 shape)
//   PATCH /api/rooms/{roomId}/matchmaking/profile — update intents /
//                                                   availability /
//                                                   discoverability
//
// P1 scope: no engine, no MCP, no UI. The enter route still returns the
// matches envelope so P3 can fill it without changing the contract.
//
// Identity: the caller is the authenticated room member. identity_id is
// auth.identityId (the room-scoped resolved identity) falling back to
// auth.member.id; kind comes from auth.member.kind and must be agent|human —
// the module never guesses it from the id shape (fail closed).
//
// Idempotency: POST enter and PATCH profile accept an idempotency key via the
// Idempotency-Key header or the `idempotencyKey` body field. A replayed key
// returns the original status and body without re-executing; the same key
// with different input is a 409. Replay scope is (caller, route, key).
//
// Error contract: MatchProfileError / MatchEventError map to their status
// codes; unknown errors are rethrown for the generic 500 path — never
// wrapped, so no internal detail leaks.
//
// MOUNTING (deferred): server/http.mjs is held live by another lane, so this
// module ships mount-ready and unmounted. The wiring task applies the mount
// patch attached to the P1 PR description (route regexes + handler dispatch
// in server/http.mjs, schema exec in server/store.mjs) as its own claimed
// task once the live claims clear.
import { createMatchProfiles, MatchProfileError } from "./match-profiles.mjs";
import { createMatchEvents, createMatchIdempotency, MatchEventError } from "./match-events.mjs";

const IDEM_HEADER = "idempotency-key";

// P1 abstention: the engine is not wired, so every matches response abstains
// honestly instead of guessing. P3 replaces this constant with real scoring.
export const P1_ABSTAIN_REASON =
  "Matchmaking P1: the matching engine is not wired yet — your seeker profile is saved " +
  "and you are in the pool. Ranked matches arrive when the engine lands (P3); until then, " +
  "browse the public opportunities feed at GET /api/opportunities.json for current bounties " +
  "and project offers.";

const emptyMatches = roomId => ({
  roomId,
  matches: [],
  abstained: true,
  abstainReason: P1_ABSTAIN_REASON,
});

// Strict body shapes: every required key present, no unknown keys.
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

const idemKeyOf = (req, payload) => {
  const header = req.headers?.[IDEM_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  if (payload && typeof payload.idempotencyKey === "string" && payload.idempotencyKey.length > 0) {
    return payload.idempotencyKey;
  }
  return null;
};

// Read a JSON body; a malformed body is a 422, matching the room's body()
// contract. Empty bodies become {} (GET-style routes ignore the body anyway).
const readPayload = async (reject, readBody, req) => {
  let payload;
  try { payload = await readBody(req); }
  catch { reject(422, "invalid_matchmaking_input", "Expected a JSON body."); }
  if (payload === undefined || payload === null || payload === "") return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    reject(422, "invalid_matchmaking_input", "Expected a JSON object.");
  }
  return payload;
};

const runMatch = (reject, fn) => {
  try { return fn(); }
  catch (error) {
    if (error instanceof MatchProfileError || error instanceof MatchEventError) {
      reject(error.status, error.code, error.message);
    }
    throw error;
  }
};

// The caller is the authenticated room member. kind is never derived from
// the id shape — a missing or unexpected kind fails closed.
const callerOf = (reject, auth) => {
  const member = auth?.member;
  const identityId = (typeof auth?.identityId === "string" && auth.identityId.length > 0)
    ? auth.identityId
    : member?.id;
  if (typeof identityId !== "string" || identityId.length < 1 || identityId.length > 256) {
    reject(422, "invalid_matchmaking_input", "identityId must be 1..256 characters");
  }
  const kind = member?.kind;
  if (kind !== "agent" && kind !== "human") {
    reject(422, "invalid_member_kind", "The member record must carry kind agent|human");
  }
  return { identityId, kind, displayName: member?.displayName ?? identityId };
};

export async function handleMatchmakingRoutes({ req, res, url, store, roomId, auth, matchmakingRoute, helpers }) {
  const { json, reject, body } = helpers;
  if (typeof roomId !== "string" || roomId.length === 0) {
    reject(422, "invalid_matchmaking_input", "roomId is required");
  }
  const db = store?.db;
  if (!db || typeof db.prepare !== "function") {
    reject(500, "misconfigured", "store.db (node:sqlite DatabaseSync) is required");
  }
  // The wiring layer may attach pre-built instances (same pattern as
  // store.bountyEscrow); otherwise construct from the store's db handle.
  const profiles = store.matchProfiles ?? createMatchProfiles({ db });
  const events = store.matchEvents ?? createMatchEvents({ db });
  const idem = store.matchIdempotency ?? createMatchIdempotency({ db });
  const tx = fn => typeof store.transaction === "function" ? store.transaction(fn) : fn();
  const { identityId, kind, displayName } = callerOf(reject, auth);

  if (matchmakingRoute === "enter") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "POST required");
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["intents"],
      optional: ["capabilities", "availability", "surfaces", "discoverable", "displayName", "rewardFloor", "idempotencyKey"] })) {
      reject(422, "invalid_matchmaking_input",
        "Expected { intents[], capabilities?, availability?, surfaces?, discoverable?, displayName?, rewardFloor?, idempotencyKey? }.");
    }
    const requestHash = idem.sha256(idem.canonicalJson(
      Object.fromEntries(Object.entries(payload).filter(([name]) => name !== "idempotencyKey"))));
    const outcome = tx(() => runMatch(reject, () => idem.runIdempotent({
      roomId, route: "matchmaking:enter", key: idemKeyOf(req, payload),
      caller: identityId, requestHash,
      thunk: () => {
        const { profile, created } = profiles.upsert({
          roomId, identityId, kind,
          displayName: typeof payload.displayName === "string" && payload.displayName.length > 0
            ? payload.displayName : displayName,
          intents: payload.intents,
          capabilities: payload.capabilities,
          availability: payload.availability,
          surfaces: payload.surfaces,
          discoverable: payload.discoverable,
          rewardFloor: payload.rewardFloor,
        });
        events.append({ roomId, identityId,
          type: created ? "profile.entered" : "profile.updated",
          data: { kind: profile.kind, intents: profile.intents,
            availability: profile.availability, discoverable: profile.discoverable,
            surfaces: profile.surfaces } });
        return { status: created ? 201 : 200,
          body: { ...emptyMatches(roomId), profile } };
      },
    })));
    return json(res, outcome.status, outcome.body);
  }

  if (matchmakingRoute === "matches") {
    if (req.method !== "GET" && req.method !== "HEAD") reject(405, "method_not_allowed", "GET required");
    const forParam = url.searchParams.get("for");
    if (forParam !== null && forParam !== "self") {
      reject(422, "invalid_matchmaking_input", '?for= must be "self"');
    }
    const outcome = tx(() => runMatch(reject, () => {
      const profile = profiles.get({ roomId, identityId });
      if (!profile) {
        reject(404, "profile_not_found",
          `No matchmaking profile for this identity in room ${roomId} — enter first: POST /api/rooms/${roomId}/matchmaking/enter`);
      }
      events.append({ roomId, identityId, type: "matches.viewed",
        data: { count: 0, abstained: true } });
      return { ...emptyMatches(roomId), profile };
    }));
    return json(res, 200, outcome, req.method === "HEAD");
  }

  if (matchmakingRoute === "profile") {
    if (req.method !== "PATCH") reject(405, "method_not_allowed", "PATCH required");
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["intents", "availability", "discoverable", "idempotencyKey"] })) {
      reject(422, "invalid_matchmaking_input",
        "Expected { intents?, availability?, discoverable?, idempotencyKey? }.");
    }
    const patchKeys = ["intents", "availability", "discoverable"].filter(k => k in payload);
    if (patchKeys.length === 0) {
      reject(422, "invalid_matchmaking_input",
        "Nothing to update: supply at least one of intents, availability, discoverable.");
    }
    const requestHash = idem.sha256(idem.canonicalJson(
      Object.fromEntries(Object.entries(payload).filter(([name]) => name !== "idempotencyKey"))));
    const outcome = tx(() => runMatch(reject, () => idem.runIdempotent({
      roomId, route: "matchmaking:profile", key: idemKeyOf(req, payload),
      caller: identityId, requestHash,
      thunk: () => {
        const profile = profiles.update({ roomId, identityId,
          ...(payload.intents !== undefined ? { intents: payload.intents } : {}),
          ...(payload.availability !== undefined ? { availability: payload.availability } : {}),
          ...(payload.discoverable !== undefined ? { discoverable: payload.discoverable } : {}),
        });
        if (!profile) {
          reject(404, "profile_not_found",
            `No matchmaking profile for this identity in room ${roomId} — enter first: POST /api/rooms/${roomId}/matchmaking/enter`);
        }
        events.append({ roomId, identityId, type: "profile.updated",
          data: { intents: profile.intents, availability: profile.availability,
            discoverable: profile.discoverable } });
        return { status: 200, body: { roomId, profile } };
      },
    })));
    return json(res, outcome.status, outcome.body);
  }

  reject(404, "not_found", "Unknown matchmaking route");
}

