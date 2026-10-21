// GET /api/rooms/{roomId}/spend-meter: the live spend tally for the room and
// each agent with a spend grant. The room owner sees every agent; any other
// member sees the room line and its own. "paused" means the hard cap is
// reached: the existing gates (spend grant cap, room allowance) refuse the
// next priced call until the owner raises the cap.
import { spendGrantSummary } from "../spend-grants.mjs";
import { spendAllowanceReport } from "../spend-allowance.mjs";
import { meterLabel, meterLine } from "../../src/spend-meter.js";

function access(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, auth };
}

// Settled priced-tool charges in the allowance period: the same sum the
// charge gate adds to the session ledger (#3302).
function settledToolCharges(db, roomId, sinceMs) {
  try {
    return Number(db.prepare("SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)),0) AS total FROM spend_authorizations WHERE room_id=? AND status='settled' AND settled_at>=?").get(roomId, sinceMs)?.total ?? 0);
  } catch { return 0; }
}

export function spendMeter(store, roomId, viewerId, nowMs = store.now()) {
  const room = store.room(roomId);
  const report = spendAllowanceReport(room.state, nowMs);
  const usedCents = report.committedCents + settledToolCharges(store.db, roomId, Date.parse(report.period.since));
  const roomLine = meterLine({ usedCents, capCents: report.allowance?.allowanceCents ?? null });
  const owner = room.state.room.ownerId === viewerId;
  const agents = [];
  for (const [memberId, member] of Object.entries(room.state.members ?? {})) {
    if (member?.active === false || (!owner && memberId !== viewerId)) continue;
    const grant = spendGrantSummary(store.db, roomId, memberId, { nowMs });
    if (!grant) continue;
    const capCents = Number(grant.capCents), leftCents = Number(grant.remainingCents);
    const line = meterLine({ usedCents: capCents - leftCents, capCents });
    agents.push({ memberId, ...line, label: meterLabel(line) });
  }
  return { roomId, period: report.period, room: { ...roomLine, label: meterLabel(roomLine) }, agents,
    paused: roomLine.paused || agents.some(a => a.memberId === viewerId && a.paused) };
}

export function readSpendMeter(ctx) {
  const { roomId, auth } = access(ctx);
  return ctx.json(ctx.res, 200, ctx.store.readTransaction(() => spendMeter(ctx.store, roomId, auth.member.id)));
}

export const SPEND_METER_ROUTES = Object.freeze([
  Object.freeze({ id: "spend-meter-read", method: "GET", path: "/api/rooms/{roomId}/spend-meter", auth: "room", capability: null, scope: "room",
    handler: readSpendMeter, parity: "exempt:HTTP-first read; the room header meter is Codex's UI follow-up",
    schema: { params: Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }), response: Object.freeze({ type: "object" }) }, events: [] }),
]);
