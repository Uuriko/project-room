// Bounty-escrow HTTP routes (agent work exchange, slice 1).
//
// Room-scoped handlers mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks — the
// same mounting pattern as server/work-claim-routes.mjs. All operations live
// under /api/rooms/{roomId}/bounties/* and /api/rooms/{roomId}/credits/* and
// are documented in docs/openapi.yaml (the route-docs gate requires it).
//
// Identity: the caller is the authenticated room member, mapped to a ledger
// lane account via canonicalLane() in server/bounty-escrow.mjs. The actor
// recorded on every transition is {kind, id} with kind derived from the
// room's live membership record (agent/human) — never from the shape of the
// lane string; mechanical keeper transitions use the rule actor.
// Credits are valueless ledger units: no cash-out, no on-chain touch, no
// real money.
//
// Lifecycle: POST /bounties creates PROPOSED (triage; locks nothing). The
// triage quartet /fund /decline /snooze /duplicate moves it out of triage;
// only FUNDED bounties are claimable. Listings filter by semantic group
// (?group=), not by display state.
//
// Error contract: the escrow module throws EscrowError (code, no HTTP
// status); escrowHttpError maps it — unknown_bounty to 404, not_authorized
// to 403, already_claimed/dispute_exists to 409, everything else to 422.
// Unknown errors are rethrown for the generic 500 path — never wrapped, so
// no internal detail leaks.
//
// Idempotency: every mutating route accepts an idempotency key via the
// Idempotency-Key header or the `idempotencyKey` body field. A replayed key
// returns the original status and body without re-executing.
import { BountyEscrow, EscrowError, canonicalLane, BOUNTY_GROUPS, normalizeActor } from "./bounty-escrow.mjs";

const IDEM_HEADER = "idempotency-key";

// Strict body shapes: every required key present, no unknown keys.
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

const invalidInput = (reject, expected) => reject(422, "invalid_bounty_input", `Expected ${expected}.`);

// Owner-only gate for the sybil resolver routes. Fails closed: no store
// authority, no member, or any mismatch is "not the owner".
export const isRoomOwner = (store, roomId, auth) => {
  const memberId = auth?.member?.id;
  if (typeof memberId !== "string" || !memberId || typeof store?.roomAuthority !== "function") return false;
  const { ownerId } = store.roomAuthority(roomId);
  return typeof ownerId === "string" && ownerId === memberId;
};

const runPure = (reject, fn) => {
  try { return fn(); }
  catch (error) {
    if (error instanceof EscrowError) {
      if (error.code === "unknown_bounty" || error.code === "unknown_flag") reject(404, error.code, error.message);
      if (error.code === "not_authorized") reject(403, error.code, error.message);
      if (error.code === "already_claimed" || error.code === "dispute_exists") reject(409, error.code, error.message);
      reject(422, error.code, error.message);
    }
    throw error;
  }
};

// The :identity path segment may carry a lane id like id:agent/jill, whose
// canonical form contains a slash — callers percent-encode it. pathId()'s
// validId check rejects slashes, so identities decode here with a looser,
// still-bounded check (the value only ever reaches SQL as a bound parameter
// and canonicalLane()).
const identityOf = (reject, encoded) => {
  let id;
  try { id = decodeURIComponent(encoded); } catch { reject(404, "not_found", "Not found"); }
  if (typeof id !== "string" || id.length < 1 || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))
    reject(422, "invalid_bounty_input", "identity must be 1..256 printable characters");
  return id;
};

const idemKeyOf = (req, payload) => {
  const header = req.headers[IDEM_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  if (payload && typeof payload.idempotencyKey === "string" && payload.idempotencyKey.length > 0) return payload.idempotencyKey;
  return null;
};

// Read a JSON body that may be empty (claim/finalize/epoch take no required
// fields); a malformed body is a 422, matching the room's body() contract.
const readPayload = async (reject, readBody, req) => {
  let payload;
  try { payload = await readBody(req); }
  catch { invalidInput(reject, "a JSON body"); }
  if (payload === undefined || payload === null || payload === "") return {};
  if (typeof payload !== "object" || Array.isArray(payload)) invalidInput(reject, "a JSON object");
  return payload;
};

export async function handleBountyEscrow({ req, res, url, store, roomId, auth, escrowRoute, bountyId, identity, sybilFlagId, helpers }) {
  const { json, reject, body } = helpers;
  const escrow = store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store);
  const caller = canonicalLane(auth.member.id);
  const actor = normalizeActor(null, caller);
  const key = payload => idemKeyOf(req, payload);
  // Spec: bounty lifecycle events go to the room feed + webhook. The
  // bounty_events table is the durable log; here each non-replayed mutation
  // fans its event out to matching webhook subscriptions (never throws — a
  // fan-out failure must not fail the mutation that triggered it).
  const publishEvent = event => {
    if (!event || !store.agentPlugin) return;
    try {
      store.agentPlugin.fanoutRoomEvent({ roomId,
        event: { id: `bounty-event-${event.seq}`, type: event.type,
          data: { ...(event.data ?? {}), bountyId: event.bountyId ?? null,
            actor: event.actor ?? null, before: event.before ?? null, after: event.after ?? null } } });
    } catch (error) { console.error("bounty webhook fan-out failed:", error?.message ?? error); }
  };
  const idem = (payload, route, status, thunk) =>
    runPure(reject, () => {
      const result = escrow.idemExecute(roomId, key(payload), route, status, () => runPure(reject, thunk));
      if (!result.replayed) publishEvent(result.body?.receipt?.event);
      return json(res, result.status, result.body);
    });

  if (escrowRoute === "list" && req.method === "GET") {
    const group = url.searchParams.get("group");
    if (group !== null && !BOUNTY_GROUPS.includes(group)) invalidInput(reject, `group one of ${BOUNTY_GROUPS.join(", ")}`);
    // Slice 4: optional per-viewer routing visibility (?viewer=self or a lane
    // id). Read-only; annotates each bounty with the routing layer's
    // band-derived claimable answer for that viewer. Bounties are never
    // hidden — visibility only.
    const viewerParam = url.searchParams.get("viewer");
    const viewer = viewerParam === null ? null : viewerParam === "self" ? caller : viewerParam;
    const bounties = runPure(reject, () => escrow.listBounties(roomId, { group, viewer }));
    return json(res, 200, { roomId, bounties });
  }
  // Slice 10: arbiter inspection of correlation review packets. Read-only
  // (rooms:read); packets are immutable once created. ?bountyId= filters
  // to one bounty's packets.
  if (escrowRoute === "reviews" && req.method === "GET") {
    const bountyId = url.searchParams.get("bountyId");
    const packets = runPure(reject, () => escrow.getReviewPackets(roomId, { bountyId }));
    return json(res, 200, { roomId, packets });
  }
  // Slice 10: the sybil-flag arbiter review queue. Read-only (rooms:read);
  // ?status= filters to open / dismissed / confirmed.
  if (escrowRoute === "sybil-flags" && req.method === "GET") {
    const status = url.searchParams.get("status");
    if (status !== null && !["open", "dismissed", "confirmed"].includes(status))
      invalidInput(reject, "status one of open, dismissed, confirmed");
    const flags = runPure(reject, () => escrow.getSybilFlags(roomId, { status }));
    return json(res, 200, { roomId, flags });
  }
  // Slice 10: resolution of a sybil flag — dismissed (honest coincidence)
  // or confirmed. Never moves bounty state, balances or bonds, but since
  // #800 a confirmed flag feeds the reputation projector (sybil_confirmed
  // per member lane, which can mean probation). Resolver policy is
  // OWNER-ONLY (project-room#266 decision 5801196661): any caller other than
  // the room owner — agent lanes, guests, members with rooms:write, and the
  // flagged lanes themselves — gets 403 before the body is read or anything
  // is written. roomAuthority() is a fresh storage read, not a cache.
  if ((escrowRoute === "sybil-dismiss" || escrowRoute === "sybil-confirm") && req.method === "POST") {
    if (!isRoomOwner(store, roomId, auth))
      reject(403, "owner_required", "Only the room owner can confirm or dismiss a sybil flag.");
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["reason"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{reason, idempotencyKey?}");
    const resolution = escrowRoute === "sybil-dismiss" ? "dismissed" : "confirmed";
    return idem(payload, `bounty.sybil-${resolution}`, 200, () =>
      runPure(reject, () => ({ roomId,
        flag: escrow.resolveSybilFlag(roomId, sybilFlagId, { resolution, reason: payload.reason, resolver: caller }) })));
  }
  // Slice 4 (reputation): arbiter/human inspection of probation-gate review
  // packets. Read-only (rooms:read); packets are immutable once created.
  if (escrowRoute === "reputation-reviews" && req.method === "GET") {
    const packets = runPure(reject, () => escrow.getReputationPackets(roomId));
    return json(res, 200, { roomId, packets });
  }
  if (escrowRoute === "create" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["title", "criteria", "amount", "deadline"], optional: ["verifierId", "rubric", "idempotencyKey"] }))
      invalidInput(reject, "{title, criteria, amount, deadline, verifierId?, rubric?, idempotencyKey?}");
    return idem(payload, "bounty.post", 201, () => {
      const { bounty, receipt } = escrow.postBounty(roomId,
        { poster: caller, title: payload.title, criteria: payload.criteria, amount: payload.amount,
          deadline: payload.deadline, verifierId: payload.verifierId ?? null, rubric: payload.rubric ?? null, actor });
      return { roomId, bounty, receipt };
    });
  }
  // Slice 6: re-pin the rubric (v+1). Poster-only; only while PROPOSED —
  // funding pins the rubric for the rest of the lifecycle.
  if (escrowRoute === "rubric" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["rubric"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{rubric: [{criterionId, description}], idempotencyKey?}");
    return idem(payload, "bounty.rubric", 200, () => {
      const { bounty, receipt } = escrow.updateRubric(roomId, bountyId,
        { poster: caller, rubric: payload.rubric, actor });
      return { roomId, bounty, receipt };
    });
  }
  // Triage quartet: poster-only transitions out of PROPOSED.
  if (escrowRoute === "fund" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["idempotencyKey"] })) invalidInput(reject, "{idempotencyKey?}");
    return idem(payload, "bounty.fund", 200, () => {
      const { bounty, receipt } = escrow.fundBounty(roomId, bountyId, { funder: caller, actor });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "decline" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["reason"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{reason, idempotencyKey?}");
    return idem(payload, "bounty.decline", 200, () => {
      const { bounty, receipt } = escrow.declineBounty(roomId, bountyId, { decliner: caller, reason: payload.reason, actor });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "snooze" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["until"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{until, idempotencyKey?}");
    return idem(payload, "bounty.snooze", 200, () => {
      const { bounty, receipt } = escrow.snoozeBounty(roomId, bountyId, { snoozer: caller, until: payload.until, actor });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "duplicate" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["canonical_id"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{canonical_id, idempotencyKey?}");
    return idem(payload, "bounty.duplicate", 200, () => {
      const { bounty, receipt } = escrow.duplicateBounty(roomId, bountyId,
        { marker: caller, canonicalId: payload.canonical_id, actor });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "watch" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["idempotencyKey"] })) invalidInput(reject, "{idempotencyKey?}");
    return idem(payload, "bounty.watch", 200, () => {
      const result = escrow.watchBounty(roomId, bountyId, { watcher: caller, actor });
      return { roomId, ...result };
    });
  }
  if (escrowRoute === "claim" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["idempotencyKey"] })) invalidInput(reject, "{idempotencyKey?}");
    return idem(payload, "bounty.claim", 200, () => {
      const { bounty, receipt } = escrow.claimBounty(roomId, bountyId, { claimant: caller, actor });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "submit" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["evidenceUrl", "summary"],
      optional: ["evidenceKind", "checksClaimed", "producerId", "idempotencyKey"] }))
      invalidInput(reject, "{evidenceUrl, summary, evidenceKind?, checksClaimed?, producerId?, idempotencyKey?}");
    return idem(payload, "bounty.submit", 200, () => {
      const { bounty, receipt } = escrow.submitWork(roomId, bountyId, { claimant: caller, actor,
        evidence: { evidenceUrl: payload.evidenceUrl, evidenceKind: payload.evidenceKind ?? null,
          summary: payload.summary, checksClaimed: payload.checksClaimed ?? [], producerId: payload.producerId ?? null } });
      return { roomId, bounty, receipt };
    });
  }
  if (escrowRoute === "accept" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["verifierAttestation"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{verifierAttestation, idempotencyKey?}");
    return idem(payload, "bounty.accept", 200, () => {
      const { bounty, approval, attribution, receipt } = escrow.acceptWork(roomId, bountyId,
        { acceptor: caller, verifierAttestation: payload.verifierAttestation, actor });
      return { roomId, bounty, approval, attribution, receipt };
    });
  }
  // Free-miss settlement: the poster (or the designated verifier) rejects
  // submitted work with a written reason. The award — still locked with the
  // poster, never attributed — refunds to the poster in full with no fee;
  // the worker settles at zero; the claim bond is forfeited and a flake
  // strike recorded (the same "work judged bad" treatment as a
  // dispute-upheld cancel). Idempotent: a replayed request replays the
  // stored settlement verdict without new journal movement.
  if (escrowRoute === "reject" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["reason"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{reason, idempotencyKey?}");
    return idem(payload, "bounty.reject", 200, () => {
      const { bounty, settlement, alreadySettled, receipt } = escrow.rejectWork(roomId, bountyId,
        { rejector: caller, reason: payload.reason, actor });
      return { roomId, bounty, settlement, alreadySettled, receipt };
    });
  }
  if (escrowRoute === "dispute" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["bond", "grounds"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{bond, grounds, idempotencyKey?}");
    return idem(payload, "bounty.dispute", 201, () => {
      const { bounty, dispute, receipt } = escrow.disputeBounty(roomId, bountyId,
        { challenger: caller, bond: payload.bond, grounds: payload.grounds, actor });
      return { roomId, bounty, dispute, receipt };
    });
  }
  if (escrowRoute === "dispute-decide" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["outcome", "reasonCodes"], optional: ["rubricCheck", "idempotencyKey"] }))
      invalidInput(reject, "{outcome, reasonCodes, rubricCheck?, idempotencyKey?}");
    return idem(payload, "bounty.dispute-decide", 200, () => {
      const { bounty, resolution, receipt } = escrow.decideDispute(roomId, bountyId,
        { decider: caller, outcome: payload.outcome, reasonCodes: payload.reasonCodes,
          rubricCheck: payload.rubricCheck ?? null, actor });
      return { roomId, bounty, resolution, receipt };
    });
  }
  if (escrowRoute === "finalize" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["idempotencyKey"] })) invalidInput(reject, "{idempotencyKey?}");
    return idem(payload, "bounty.finalize", 200, () => {
      const { bounty, action, receipt } = escrow.finalizeBounty(roomId, bountyId, { caller });
      return { roomId, bounty, action, receipt };
    });
  }
  if (escrowRoute === "balances" && req.method === "GET") {
    const balances = runPure(reject, () => escrow.balances(roomId, identityOf(reject, identity)));
    return json(res, 200, { roomId, balances });
  }
  if (escrowRoute === "history" && req.method === "GET") {
    const params = url.searchParams;
    const state = params.get("state"), since = params.get("since");
    const receipts = runPure(reject, () => escrow.history(roomId, identityOf(reject, identity),
      { state: state ?? null, since: since ?? null }));
    return json(res, 200, { roomId, receipts });
  }
  if (escrowRoute === "transfer" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: ["to", "amount"], optional: ["idempotencyKey"] }))
      invalidInput(reject, "{to, amount, idempotencyKey?}");
    return idem(payload, "credit.transfer", 200, () => {
      const result = escrow.transfer(roomId, { from: caller, to: payload.to, amount: payload.amount, actor });
      return { roomId, ...result };
    });
  }
  if (escrowRoute === "epoch-close" && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { optional: ["idempotencyKey"] })) invalidInput(reject, "{idempotencyKey?}");
    return idem(payload, "credit.epoch-close", 200, () => {
      const epoch = escrow.closeEpoch(roomId, { caller });
      return { roomId, epoch };
    });
  }
  reject(405, "method_not_allowed", "Method not allowed");
}
