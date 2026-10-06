// Matchmaking HTTP routes: the arrival surface.
//
// Three modules were built and green and unreachable — an agent could not
// declare what it wants, a room could not declare what an opening needs, and
// nothing paired them. This mounts them under
// /api/rooms/{roomId}/matchmaking/* in the same pattern as
// server/work-claim-routes.mjs: room-scoped handlers mounted by
// server/http.mjs inside the authenticated room block, after the shared
// credential, fence and rate-limit checks.
//
// Identity: the seeker is always the authenticated member (auth.member.id).
// A caller cannot declare on another agent's behalf, so the seekerId is
// never read from the body — matching for someone else is a different
// feature and needs its own consent story.
//
// Error contract: the pure modules throw Error with a plain message and no
// HTTP status. Bad input maps to 422 invalid_matchmaking_input; an unknown
// work item or decision to 404; a caller with no declaration on file to 409,
// because matching without declaring is a sequencing mistake and not a
// validation one. Unknown errors are rethrown for the generic 500 path.
import { declareSeeker, describeOpening, matchWork } from "./work-matchmaking.mjs";
import { rowToSeeker, seekerToRow, openingsFromRows } from "./work-declarations.mjs";
import { openDecision, routeDecision, recordAnswer, decisionAsOpening } from "./agent-lanes.mjs";

// In-memory registry. Production passes the store-owned one; this is the
// shape both must satisfy, and the only one the tests need.
export function createMatchmakingRegistry() {
  const rooms = new Map();
  const room = roomId => {
    let entry = rooms.get(roomId);
    if (!entry) { entry = { seekers: new Map(), terms: new Map(), decisions: new Map(), lanes: new Map(), answers: new Map() }; rooms.set(roomId, entry); }
    return entry;
  };
  return {
    putSeeker(roomId, row) { room(roomId).seekers.set(row.identity_id, row); return row; },
    getSeeker(roomId, seekerId) { return room(roomId).seekers.get(seekerId) ?? null; },
    putTerms(roomId, row) { room(roomId).terms.set(row.work_id, row); return row; },
    termRows(roomId) { return [...room(roomId).terms.values()]; },
    putDecision(roomId, decision) { room(roomId).decisions.set(decision.decisionId, decision); return decision; },
    getDecision(roomId, id) { return room(roomId).decisions.get(id) ?? null; },
    putLane(roomId, lane) { room(roomId).lanes.set(lane.agentId, lane); return lane; },
    putAnswer(roomId, record) { room(roomId).answers.set(record.decisionId, record); return record; },
    getAnswer(roomId, decisionId) { return room(roomId).answers.get(decisionId) ?? null; },
    lanes(roomId) { return [...room(roomId).lanes.values()]; },
  };
}

const defaultRegistry = createMatchmakingRegistry();

export async function handleMatchmaking(options) {
  const { req, res, helpers, reauthorize } = options;
  const registry = options.registry ?? options.store?.matchmaking ?? defaultRegistry;
  const requestData = ["POST", "PUT", "PATCH"].includes(req.method) ? await helpers.body(req) : undefined;
  const result = handleMatchmakingCore({
    ...options, registry,
    auth: reauthorize ? reauthorize() : options.auth,
    helpers: { ...helpers, body: () => requestData, json: (_res, status, value) => ({ status, value }) },
  });
  return helpers.json(res, result.status, result.value);
}

export function handleMatchmakingCore({ req, store, roomId, auth, matchmakingRoute, matchmakingId, helpers, registry, now = Date.now() }) {
  const { json, reject, body } = helpers;
  const caller = auth.member.id;
  const nowIso = new Date(now).toISOString();

  const invalid = error => reject(422, "invalid_matchmaking_input", error.message);
  const guard = thunk => { try { return thunk(); } catch (error) {
    if (error instanceof Error && !error.status) invalid(error);
    throw error;
  } };

  switch (matchmakingRoute) {
    // An agent says what it is here for. Motive, capabilities, appetite.
    case "declare": {
      const input = body() ?? {};
      const seeker = guard(() => declareSeeker({
        seekerId: caller,
        motives: input.motives,
        capabilities: input.capabilities ?? [],
        appetiteMinutes: input.appetiteMinutes,
        trustTier: input.trustTier ?? 0,
      }));
      const row = registry.putSeeker(roomId, seekerToRow(seeker, { now: () => now }));
      return json(null, 201, { roomId, seeker: rowToSeeker(row) });
    }

    // A room says what an opening needs. Undeclared work stays claimable by
    // id and invisible to matching, which is the point of a separate call.
    case "offer": {
      const input = body() ?? {};
      const opening = guard(() => describeOpening({
        openingId: input.workId, roomId, title: input.title,
        rewardKind: input.rewardKind, rewardAmount: input.rewardAmount ?? 0,
        requires: input.requires ?? [], sizeMinutes: input.sizeMinutes,
        trustFloor: input.trustFloor ?? 0, open: input.open ?? true,
        deadline: input.deadline ?? null,
      }));
      registry.putTerms(roomId, {
        work_id: opening.openingId, room_id: roomId, reward_kind: opening.rewardKind,
        reward_amount: opening.rewardAmount, requires: JSON.stringify(opening.requires),
        size_minutes: opening.sizeMinutes, trust_floor: opening.trustFloor,
        deadline: opening.deadline, title: opening.title, open: opening.open,
        declared_at: nowIso,
      });
      return json(null, 201, { roomId, opening });
    }

    // The pairing itself. One match, up to three alternatives, and a coded
    // reason for every opening that was passed over.
    case "match": {
      const row = registry.getSeeker(roomId, caller);
      if (!row) reject(409, "not_declared", "Declare what you are looking for before asking for a match");
      const rows = registry.termRows(roomId);
      const titles = Object.fromEntries(rows.map(r => [r.work_id, r.title ?? r.work_id]));
      const closed = rows.filter(r => r.open === false).map(r => r.work_id);
      const board = openingsFromRows(rows, { titles, closed });
      const outcome = guard(() => matchWork({ seeker: rowToSeeker(row), openings: board.openings, now: () => now }));
      return json(null, 200, { roomId, ...outcome, undeclared: board.skipped });
    }

    // A human decision, entered as routable work. The lane chain decides who
    // gets asked; the courier carries the answer and never gives one.
    case "decision-open": {
      const input = body() ?? {};
      const decision = guard(() => openDecision({
        decisionId: input.decisionId, roomId, question: input.question,
        needsAuthority: input.needsAuthority, notAfter: input.notAfter ?? null,
        blocking: input.blocking ?? [],
      }));
      const routed = guard(() => routeDecision({
        decision, lanes: registry.lanes(roomId), now: () => now,
        wakingHours: input.wakingHours ?? true,
      }));
      registry.putDecision(roomId, decision);
      return json(null, 201, { roomId, decision,
        chain: routed.chain, setAside: routed.setAside,
        unreachable: routed.unreachable, expired: routed.expired,
        opening: decisionAsOpening(decision) });
    }

    case "decision-answer": {
      const input = body() ?? {};
      const decision = registry.getDecision(roomId, matchmakingId);
      if (!decision) reject(404, "decision_not_found", `No decision "${matchmakingId}" in this room`);
      // The caller has to be a registered courier in this room. A courier
      // relays; the author is the person named in the body, and the two can
      // never be the same agent.
      const courier = registry.lanes(roomId).find(lane => lane.agentId === caller) ?? null;
      if (!courier) reject(403, "lane_not_registered", "Register a lane before carrying a decision");
      const record = guard(() => recordAnswer({
        decision, courier, answer: input.answer,
        answeredBy: input.answeredBy, answeredAt: now, note: input.note ?? "",
      }));
      registry.putAnswer(roomId, record);
      return json(null, 200, { roomId, answer: record });
    }

    case "decision-read": {
      const decision = registry.getDecision(roomId, matchmakingId);
      if (!decision) reject(404, "decision_not_found", `No decision "${matchmakingId}" in this room`);
      return json(null, 200, { roomId, decision, answer: registry.getAnswer(roomId, matchmakingId) });
    }

    default:
      reject(404, "not_found", "Unknown matchmaking route");
  }
  return json(null, 500, {});
}
