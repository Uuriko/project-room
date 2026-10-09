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
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";

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

// EscrowError code -> HTTP status. reject() throws, so the first (only)
// applicable mapping wins; anything unlisted is 422.
const ESCROW_HTTP_STATUS = {
  unknown_bounty: 404, unknown_flag: 404,
  not_authorized: 403,
  already_claimed: 409, dispute_exists: 409,
  idempotency_actor_mismatch: 409, idempotency_key_reused: 409,
};
const runPure = (reject, fn) => {
  try { return fn(); }
  catch (error) {
    if (error instanceof EscrowError) reject(ESCROW_HTTP_STATUS[error.code] ?? 422, error.code, error.message);
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

// Share lifecycle delivery across HTTP and MCP; retries never publish twice.
export function publishBountyEvent(store, roomId, event) {
  if (!event || !store.agentPlugin) return;
  try {
    store.agentPlugin.fanoutRoomEvent({ roomId,
      event: { id: `bounty-event-${event.seq}`, type: event.type,
        data: { ...(event.data ?? {}), bountyId: event.bountyId ?? null,
          actor: event.actor ?? null, before: event.before ?? null, after: event.after ?? null } } });
  } catch (error) { console.error("bounty webhook fan-out failed:", error?.message ?? error); }
}

export async function handleBountyEscrow({ req, res, url, store, roomId, auth, escrowRoute, bountyId, identity, sybilFlagId, reauthorize, helpers }) {
  const { json, reject, body } = helpers;
  if (req.method !== "GET" && req.method !== "HEAD") enforceAutonomyTierForAction({
    db: store.db, roomId, state: { room: { ownerId: store.roomAuthority?.(roomId)?.ownerId } },
    actor: auth.member, action: `${req.method} bounty ${escrowRoute}`, fail: reject });
  const escrow = store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store);
  const caller = canonicalLane(auth.member.id);
  const actor = normalizeActor(null, caller);
  const key = payload => idemKeyOf(req, payload);
  const idem = (payload, route, status, thunk) =>
    runPure(reject, () => {
      const result = store.transaction(() => {
        // Body upload is asynchronous. Recheck the original credential and
        // session fence inside the same transaction as replay or mutation.
        if (typeof reauthorize !== "function") reject(403, "access_denied", "Fresh authorization is required");
        const current = reauthorize();
        if (current.member.id !== auth.member.id) reject(403, "access_denied", "The acting identity changed");
        if (["sybil-dismiss", "sybil-confirm"].includes(escrowRoute) && !isRoomOwner(store, roomId, current))
          reject(403, "owner_required", "Only the room owner can confirm or dismiss a sybil flag.");
        enforceAutonomyTierForAction({ db: store.db, roomId,
          state: { room: { ownerId: store.roomAuthority?.(roomId)?.ownerId } },
          actor: current.member, action: `${req.method} bounty ${escrowRoute}`, fail: reject });
        return escrow.idemExecute(roomId, key(payload), route, status, () => runPure(reject, thunk),
          { callerLane: caller, bountyId: bountyId ?? sybilFlagId ?? null, payload: Object.fromEntries(Object.entries(payload).filter(([name]) => name !== "idempotencyKey")) });
      });
      if (!result.replayed) publishBountyEvent(store, roomId, result.body?.receipt?.event);
      return json(res, result.status, result.body);
    });

  if (escrowRoute === "list" && req.method === "GET") {
    const group = url.searchParams.get("group");
    if (group !== null && !BOUNTY_GROUPS.includes(group)) invalidInput(reject, `group one of ${BOUNTY_GROUPS.join(", ")}`);
    // "self" resolves to the caller for the viewer/poster params (documented
    // below); any other value passes through verbatim.
    const self = param => param === null ? null : param === "self" ? caller : param;
    // Slice 4: optional per-viewer routing visibility (?viewer=self or a lane
    // id). Read-only; annotates each bounty with the routing layer's
    // band-derived claimable answer for that viewer. Bounties are never
    // hidden — visibility only.
    const viewer = self(url.searchParams.get("viewer"));
    // ?poster= filters to bounties posted by a lane; "self" means the caller.
    // Lets a poster see their own bounties (proposed, funded, or otherwise).
    const poster = self(url.searchParams.get("poster"));
    const bounties = runPure(reject, () => escrow.listBounties(roomId, { group, viewer, poster }));
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
  // Table-driven mutations: one shared shape check + idempotency wrapper for
  // every POST mutation. Each entry keeps its exact body schema, the
  // idempotency route/status pair, and the escrow call with its exact
  // response construction — watch/transfer spread the whole escrow result,
  // the rest return {roomId, ...named}; key order and extra-key elision are
  // preserved verbatim so payloads are byte-compatible with the old code.
  const MUTATIONS = {
    create: {
      required: ["title", "criteria", "amount", "deadline"], optional: ["verifierId", "approvalMode", "rubric", "idempotencyKey"],
      expected: "{title, criteria, amount, deadline, verifierId?, approvalMode?, rubric?, idempotencyKey?}",
      idem: ["bounty.post", 201],
      exec: p => { const { bounty, receipt } = escrow.postBounty(roomId,
        { poster: caller, title: p.title, criteria: p.criteria, amount: p.amount, deadline: p.deadline,
          verifierId: p.verifierId ?? null, approvalMode: p.approvalMode ?? "human", rubric: p.rubric ?? null, actor });
        return { roomId, bounty, receipt }; },
    },
    // Slice 6: re-pin the rubric (v+1). Poster-only; only while PROPOSED —
    // funding pins the rubric for the rest of the lifecycle.
    rubric: {
      required: ["rubric"], optional: ["idempotencyKey"],
      expected: "{rubric: [{criterionId, description}], idempotencyKey?}",
      idem: ["bounty.rubric", 200],
      exec: p => { const { bounty, receipt } = escrow.updateRubric(roomId, bountyId, { poster: caller, rubric: p.rubric, actor });
        return { roomId, bounty, receipt }; },
    },
    // Triage quartet: poster-only transitions out of PROPOSED.
    fund: {
      optional: ["idempotencyKey"], expected: "{idempotencyKey?}",
      idem: ["bounty.fund", 200],
      exec: () => { const { bounty, receipt } = escrow.fundBounty(roomId, bountyId, { funder: caller, actor });
        return { roomId, bounty, receipt }; },
    },
    decline: {
      required: ["reason"], optional: ["idempotencyKey"], expected: "{reason, idempotencyKey?}",
      idem: ["bounty.decline", 200],
      exec: p => { const { bounty, receipt } = escrow.declineBounty(roomId, bountyId, { decliner: caller, reason: p.reason, actor });
        return { roomId, bounty, receipt }; },
    },
    snooze: {
      required: ["until"], optional: ["idempotencyKey"], expected: "{until, idempotencyKey?}",
      idem: ["bounty.snooze", 200],
      exec: p => { const { bounty, receipt } = escrow.snoozeBounty(roomId, bountyId, { snoozer: caller, until: p.until, actor });
        return { roomId, bounty, receipt }; },
    },
    duplicate: {
      required: ["canonical_id"], optional: ["idempotencyKey"], expected: "{canonical_id, idempotencyKey?}",
      idem: ["bounty.duplicate", 200],
      exec: p => { const { bounty, receipt } = escrow.duplicateBounty(roomId, bountyId, { marker: caller, canonicalId: p.canonical_id, actor });
        return { roomId, bounty, receipt }; },
    },
    watch: {
      optional: ["idempotencyKey"], expected: "{idempotencyKey?}",
      idem: ["bounty.watch", 200],
      exec: () => { const result = escrow.watchBounty(roomId, bountyId, { watcher: caller, actor });
        return { roomId, ...result }; },
    },
    claim: {
      optional: ["idempotencyKey"], expected: "{idempotencyKey?}",
      idem: ["bounty.claim", 200],
      exec: () => { const { bounty, receipt } = escrow.claimBounty(roomId, bountyId, { claimant: caller, actor });
        return { roomId, bounty, receipt }; },
    },
    submit: {
      required: ["evidenceUrl", "summary"], optional: ["evidenceKind", "checksClaimed", "producerId", "idempotencyKey"],
      expected: "{evidenceUrl, summary, evidenceKind?, checksClaimed?, producerId?, idempotencyKey?}",
      idem: ["bounty.submit", 200],
      exec: p => { const { bounty, receipt } = escrow.submitWork(roomId, bountyId, { claimant: caller, actor,
        evidence: { evidenceUrl: p.evidenceUrl, evidenceKind: p.evidenceKind ?? null, summary: p.summary,
          checksClaimed: p.checksClaimed ?? [], producerId: p.producerId ?? null } });
        return { roomId, bounty, receipt }; },
    },
    accept: {
      required: ["verifierAttestation"], optional: ["idempotencyKey"], expected: "{verifierAttestation, idempotencyKey?}",
      idem: ["bounty.accept", 200],
      exec: p => { const { bounty, approval, attribution, receipt } = escrow.acceptWork(roomId, bountyId,
        { acceptor: caller, verifierAttestation: p.verifierAttestation, actor });
        return { roomId, bounty, approval, attribution, receipt }; },
    },
    // Free-miss settlement: the poster (or the designated verifier) rejects
    // submitted work with a written reason. The award — still locked with the
    // poster, never attributed — refunds to the poster in full with no fee;
    // the worker settles at zero; the claim bond is forfeited and a flake
    // strike recorded (the same "work judged bad" treatment as a
    // dispute-upheld cancel). Idempotent: a replayed request replays the
    // stored settlement verdict without new journal movement.
    reject: {
      required: ["reason"], optional: ["idempotencyKey"], expected: "{reason, idempotencyKey?}",
      idem: ["bounty.reject", 200],
      exec: p => { const { bounty, settlement, alreadySettled, receipt } = escrow.rejectWork(roomId, bountyId,
        { rejector: caller, reason: p.reason, actor });
        return { roomId, bounty, settlement, alreadySettled, receipt }; },
    },
    dispute: {
      required: ["bond", "grounds"], optional: ["idempotencyKey"], expected: "{bond, grounds, idempotencyKey?}",
      idem: ["bounty.dispute", 201],
      exec: p => { const { bounty, dispute, receipt } = escrow.disputeBounty(roomId, bountyId,
        { challenger: caller, bond: p.bond, grounds: p.grounds, actor });
        return { roomId, bounty, dispute, receipt }; },
    },
    "dispute-decide": {
      required: ["outcome", "reasonCodes"], optional: ["rubricCheck", "idempotencyKey"],
      expected: "{outcome, reasonCodes, rubricCheck?, idempotencyKey?}",
      idem: ["bounty.dispute-decide", 200],
      exec: p => { const { bounty, resolution, receipt } = escrow.decideDispute(roomId, bountyId,
        { decider: caller, outcome: p.outcome, reasonCodes: p.reasonCodes, rubricCheck: p.rubricCheck ?? null, actor });
        return { roomId, bounty, resolution, receipt }; },
    },
    finalize: {
      optional: ["idempotencyKey"], expected: "{idempotencyKey?}",
      idem: ["bounty.finalize", 200],
      exec: () => { const { bounty, action, receipt } = escrow.finalizeBounty(roomId, bountyId, { caller });
        return { roomId, bounty, action, receipt }; },
    },
    transfer: {
      required: ["to", "amount"], optional: ["idempotencyKey"], expected: "{to, amount, idempotencyKey?}",
      idem: ["credit.transfer", 200],
      exec: p => { const result = escrow.transfer(roomId, { from: caller, to: p.to, amount: p.amount, actor });
        return { roomId, ...result }; },
    },
    "epoch-close": {
      optional: ["idempotencyKey"], expected: "{idempotencyKey?}",
      idem: ["credit.epoch-close", 200],
      exec: () => { const epoch = escrow.closeEpoch(roomId, { caller });
        return { roomId, epoch }; },
    },
  };
  const mutation = MUTATIONS[escrowRoute];
  if (mutation && req.method === "POST") {
    const payload = await readPayload(reject, body, req);
    if (!shape(payload, { required: mutation.required ?? [], optional: mutation.optional ?? [] }))
      invalidInput(reject, mutation.expected);
    const [idemRoute, idemStatus] = mutation.idem;
    return idem(payload, idemRoute, idemStatus, () => mutation.exec(payload));
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
  reject(405, "method_not_allowed", "Method not allowed");
}
