// Attested-ballot routes (batch RT).
//
// The attested-ballot vote rooms (identity-sybil guild W6) enter the route
// table from birth: batch RT forbids new legacy-chain routes in
// server/http.mjs (the legacy allowlist only shrinks), so these rows are the
// only wiring. Auth mirrors the legacy room chain exactly: room credential,
// fence, roomAuth, bearer/session checks, read/write rate limits, API-key
// rooms:read/rooms:write scopes, guest write denial, member-active check —
// the same authenticateRoom helper shape as server/routes/work-claims.mjs.
// The row auth column is documentation (the production hook does not set
// ctx.pipeline); the handlers enforce their own authorization.
//
// The voter is bound separately from the room member: challenge, register
// and ballot requests carry the voter's pri_ identity secret in the
// x-identity-secret header, resolved by handleAttestedVotes
// (server/attested-vote-routes.mjs) against the identity registry.

import { handleAttestedVotes } from "../attested-vote-routes.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";

function requireRoomScope(ctx, auth, writing = false) {
  const required = writing ? "rooms:write" : "rooms:read";
  if (auth.kind !== "api-key") return;
  const granted = (auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*");
  if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
}

function authenticateRoom(ctx, writing = false) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") {
    ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  }
  if (!selected.bearer && auth.kind !== "session") {
    ctx.reject(401, "unauthenticated", "Browser session required");
  }
  ctx.rate(`read:${auth.credentialHash}`, 600);
  requireRoomScope(ctx, auth, writing);
  if (writing) {
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  const members = ctx.store.roomAuthority(roomId).members ?? {};
  const member = members[auth.member.id];
  if (!member || member.active === false) {
    ctx.reject(403, "not_member", `Member "${auth.member.id}" is not a member of room "${roomId}"`);
  }
  return { roomId, auth };
}

const callHandler = (ctx, attestedVoteRoute, writing) => {
  const { roomId, auth } = authenticateRoom(ctx, writing);
  return handleAttestedVotes({ req: ctx.req, res: ctx.res, url: ctx.url, store: ctx.store, roomId, auth,
    attestedVoteRoute, voteRoomId: ctx.params.voteRoomId ?? null,
    helpers: { json: ctx.json, reject: ctx.reject, body: ctx.body } });
};

export async function listVoteRoomsRoute(ctx) { return callHandler(ctx, "list", false); }
export async function createVoteRoomRoute(ctx) { return callHandler(ctx, "create", true); }
export async function readVoteRoomRoute(ctx) { return callHandler(ctx, "read", false); }
export async function registerVoterRoute(ctx) { return callHandler(ctx, "register", true); }
export async function issueChallengeRoute(ctx) { return callHandler(ctx, "challenge", true); }
export async function castBallotRoute(ctx) { return callHandler(ctx, "cast", true); }
export async function listBallotsRoute(ctx) { return callHandler(ctx, "ballots", false); }
export async function tallyVoteRoomRoute(ctx) { return callHandler(ctx, "tally", false); }

const roomParams = { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } };
const roomVoteParams = { type: "object", required: ["roomId", "voteRoomId"],
  properties: { roomId: { type: "string" }, voteRoomId: { type: "string" } } };
const identityBody = { type: "object", required: ["identityId"], additionalProperties: false,
  properties: { identityId: { type: "string" } } };
const ballotBody = { type: "object", required: ["identityId", "choice"], additionalProperties: false,
  properties: {
    identityId: { type: "string" },
    choice: { type: ["string", "array"], description: "Option id, or ranked list of option ids" },
    nonce: { type: "string" },
    challengeId: { type: "string" },
    issuedAt: { type: "integer" },
    signature: { type: "string" },
  } };
const voteRoomBody = { type: "object", required: ["title", "mode", "options"], additionalProperties: false,
  properties: {
    title: { type: "string" },
    mode: { type: "string", enum: ["allowlist", "open"] },
    identityIds: { type: "array", items: { type: "string" } },
    options: { type: "array", items: { type: "object" } },
    opensAt: { type: "integer" },
    closesAt: { type: "integer" },
    proofMode: { type: "string", enum: ["signature", "server", "either"] },
  } };

export const ATTESTED_VOTE_ROUTES = Object.freeze([
  Object.freeze({ id: "vote-rooms-list", method: "GET", path: "/api/rooms/{roomId}/vote-rooms",
    auth: "room", capability: null, scope: "room", handler: listVoteRoomsRoute,
    schema: { params: roomParams, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-rooms-create", method: "POST", path: "/api/rooms/{roomId}/vote-rooms",
    auth: "room", capability: null, scope: "room", handler: createVoteRoomRoute,
    schema: { params: roomParams, body: voteRoomBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-read", method: "GET", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}",
    auth: "room", capability: null, scope: "room", handler: readVoteRoomRoute,
    schema: { params: roomVoteParams, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-register", method: "POST", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}/register",
    auth: "room", capability: null, scope: "room", handler: registerVoterRoute,
    schema: { params: roomVoteParams, body: identityBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-challenge", method: "POST", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}/challenge",
    auth: "room", capability: null, scope: "room", handler: issueChallengeRoute,
    schema: { params: roomVoteParams, body: identityBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-ballots-cast", method: "POST", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}/ballots",
    auth: "room", capability: null, scope: "room", handler: castBallotRoute,
    schema: { params: roomVoteParams, body: ballotBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-ballots-list", method: "GET", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}/ballots",
    auth: "room", capability: null, scope: "room", handler: listBallotsRoute,
    schema: { params: roomVoteParams, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "vote-room-tally", method: "GET", path: "/api/rooms/{roomId}/vote-rooms/{voteRoomId}/tally",
    auth: "room", capability: null, scope: "room", handler: tallyVoteRoomRoute,
    schema: { params: roomVoteParams, response: { type: "object" } }, events: [] }),
]);
