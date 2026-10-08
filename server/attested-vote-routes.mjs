// Attested-ballot HTTP routes (identity-sybil guild W6).
//
// Room-scoped handlers mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks — the
// same mounting pattern as server/work-claim-routes.mjs. Vote operations
// live under /api/rooms/{roomId}/vote-rooms/* and are documented in
// docs/openapi.yaml (the route-docs gate requires it) plus
// server/discoverability.mjs (the served-coverage gate requires it).
//
// Identity: the room credential authenticates the channel; the VOTER is bound
// separately via the x-identity-secret header (the voter's pri_ identity
// secret, resolved with resolveGlobalIdentitySecret). body.identityId must
// match the secret's identity or the request is 403 invite_identity_mismatch.
// The module (server/attested-votes.mjs) trusts the bound identityId the way
// work-claims trusts auth.member.id.
//
// Error contract: the module throws ServiceError(status, code, message,
// detail); this handler serializes to { error: { code, message, detail? } }.
// Unknown errors are rethrown for the generic 500 path — never wrapped.
import { AttestedVotes } from "./attested-votes.mjs";
import { ServiceError } from "./service-error.mjs";

const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Strict body shapes: every required key present, no unknown keys.
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

export async function handleAttestedVotes({ req, res, store, roomId, auth, attestedVoteRoute, voteRoomId, helpers }) {
  const { json, reject, body } = helpers;
  const votes = store.attestedVotes ?? new AttestedVotes(store);

  // The voter is the identity behind x-identity-secret, not the room member.
  const resolveVoter = () => {
    const secret = req.headers["x-identity-secret"];
    if (typeof secret !== "string" || secret.length === 0) {
      reject(401, "unauthenticated", "An identity secret (x-identity-secret header) is required to vote");
    }
    const resolved = store.identities.resolveGlobalIdentitySecret(secret);
    if (!resolved) reject(401, "unauthenticated", "Unknown agent identity");
    return resolved.identityId;
  };
  // Binds body.identityId to the secret's identity (spec §7.3
  // invite_identity_mismatch): claiming another identity's vote is refused.
  const bindIdentity = data => {
    const voterId = resolveVoter();
    const claimed = data?.identityId;
    if (typeof claimed !== "string" || !IDENTITY_ID_PATTERN.test(claimed)) {
      reject(422, "invalid_ballot", "identityId must be a valid agent identity id");
    }
    if (claimed !== voterId) reject(403, "invite_identity_mismatch", "The identity secret does not belong to the claimed identity");
    return voterId;
  };
  const requireWriteMethod = () => {
    if (req.method !== "POST") reject(405, "method_not_allowed", "This route only accepts POST");
  };

  try {
    switch (attestedVoteRoute) {
      case "list":
        return json(res, 200, { voteRooms: votes.listVoteRooms(roomId) });
      case "create": {
        requireWriteMethod();
        if (!(auth.member?.permissions ?? []).includes("manage_members")) {
          reject(403, "access_denied", "Only the room owner (manage_members) can open a vote room");
        }
        const data = await body(req);
        if (!shape(data, { required: ["title", "mode", "options"],
          optional: ["identityIds", "opensAt", "closesAt", "proofMode"] })) {
          reject(422, "invalid_vote_room", "Expected { title, mode, options, identityIds?, opensAt?, closesAt?, proofMode? }.");
        }
        const room = votes.createVoteRoom({ roomId, createdBy: auth.member.id, ...data });
        return json(res, 201, { voteRoomId: room.voteRoomId, voteRoom: room });
      }
      case "read": {
        const room = votes.getVoteRoom(roomId, voteRoomId);
        const { admittedCount, ballotsCast, ...voteRoom } = room;
        return json(res, 200, { voteRoom, admittedCount, ballotsCast });
      }
      case "register": {
        requireWriteMethod();
        const data = await body(req);
        if (!shape(data, { required: ["identityId"] })) reject(422, "invalid_ballot", "Expected { identityId }.");
        const identityId = bindIdentity(data);
        return json(res, 201, votes.register({ roomId, voteRoomId, identityId }));
      }
      case "challenge": {
        requireWriteMethod();
        const data = await body(req);
        if (!shape(data, { required: ["identityId"] })) reject(422, "invalid_ballot", "Expected { identityId }.");
        const identityId = bindIdentity(data);
        return json(res, 201, votes.issueChallenge({ roomId, voteRoomId, identityId }));
      }
      case "cast": {
        requireWriteMethod();
        const data = await body(req);
        if (!shape(data, { required: ["identityId", "choice"],
          optional: ["nonce", "challengeId", "issuedAt", "signature"] })) {
          reject(422, "invalid_ballot", "Expected { identityId, choice, nonce?, challengeId?, issuedAt?, signature? }.");
        }
        const identityId = bindIdentity(data);
        const { receipt, created } = votes.castBallot({ roomId, voteRoomId, identityId, ...data });
        return json(res, created ? 201 : 200, receipt);
      }
      case "ballots":
        return json(res, 200, { voteRoomId, ballots: votes.listBallots(roomId, voteRoomId) });
      case "tally":
        return json(res, 200, votes.tally(roomId, voteRoomId));
      default:
        reject(404, "not_found", "Not found");
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      const payload = { error: { code: error.code, message: error.message } };
      if (error.detail !== undefined) payload.error.detail = error.detail;
      return json(res, error.status, payload);
    }
    throw error;
  }
}
