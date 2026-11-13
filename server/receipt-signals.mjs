// Receipts as typed signals. When a public message that parseReceipt already
// recognizes (PROD DEPLOY, PROD ROLLBACK, MERGED #n, CI #n) lands in a room,
// append the structured twin to room_signal_log: pr.merged, ci.settled,
// deploy.finished (+ smoke.passed / smoke.failed when the receipt says so) and
// rollback. No workflow or secret changes: the text post stays the source, this
// is its typed index. The log is a diagnostic ledger, not an authority: a
// receipt is exactly as trustworthy as the post it came from, and the row says
// who posted it (actor_id).
//
// The project-state read prefers these rows when the log holds a good deploy
// anchor (so it reads a handful of indexed rows instead of scanning the journal
// tail), and falls back to the journal text parse otherwise.
import { parseReceipt } from "./receipts.mjs";
import { appendSignal } from "./signal-log.mjs";

const PREFILTER = /^(PROD DEPLOY |PROD ROLLBACK |MERGED #|CI #)/;
const firstLine = body => (typeof body === "string" ? body.split("\n", 1)[0] : "");

// Called from the message post path after the event is stored. Never throws.
// Private messages (toMemberId) are never receipts and never logged.
export function recordReceiptSignal(db, { roomId, at, actorId = null, body, eventId = null, journalSeq, toMemberId = null }) {
  try {
    if (toMemberId || !PREFILTER.test(firstLine(body)) || !Number.isSafeInteger(journalSeq)) return 0;
    const parsed = parseReceipt(body);
    if (!parsed) return 0;
    const ts = Number.isFinite(at) ? at : Date.parse(at);
    if (!Number.isSafeInteger(ts)) return 0;
    const base = { roomId, at: ts, actorId, ref: eventId };
    const js = journalSeq;
    let n = 0;
    const put = (type, detail) => { if (appendSignal(db, { ...base, type, detail })) n += 1; };
    if (parsed.kind === "deploy") {
      put("deploy.finished", { sha: parsed.sha, sm: parsed.smoke, js });
      if (parsed.smoke === "ok") put("smoke.passed", { sha: parsed.sha, js });
      else if (parsed.smoke === "failed") put("smoke.failed", { sha: parsed.sha, js });
    } else if (parsed.kind === "rollback") put("rollback", { sm: parsed.smoke, js });
    else if (parsed.kind === "merged") put("pr.merged", { pr: parsed.pr, sha: parsed.sha, t: parsed.title ?? "", js });
    else if (parsed.kind === "ci") put("ci.settled", { pr: parsed.pr, sha: parsed.sha, v: parsed.verdict, dt: parsed.detail ?? "", js });
    return n;
  } catch {
    return 0;
  }
}

// Newest receipts first, in parseReceipt's shape, from the partial index over
// non-wake rows (reads only receipt rows). Rows at or below floorSeq (the
// viewer's history floor / window) are excluded. Returns null when the table
// does not exist yet.
export function readReceiptSignals(db, roomId, { floorSeq = 0, limit = 200 } = {}) {
  let rows;
  try {
    rows = db.prepare(`SELECT type, ts_ms AS ts, actor_id AS actorId, detail FROM room_signal_log INDEXED BY room_signal_log_receipts
      WHERE room_id=? AND type NOT LIKE 'wake.%' ORDER BY seq DESC LIMIT ?`).all(roomId, limit);
  } catch { return null; }
  const out = [];
  for (const row of rows) {
    let d; try { d = JSON.parse(row.detail); } catch { continue; }
    if (!Number.isSafeInteger(d.js) || d.js <= floorSeq) continue;
    let parsed = null;
    if (row.type === "deploy.finished") parsed = { kind: "deploy", sha: d.sha, smoke: d.sm };
    else if (row.type === "rollback") parsed = { kind: "rollback", smoke: d.sm };
    else if (row.type === "pr.merged") parsed = { kind: "merged", pr: d.pr, sha: d.sha, title: d.t };
    else if (row.type === "ci.settled") parsed = { kind: "ci", pr: d.pr, sha: d.sha, verdict: d.v, detail: d.dt };
    if (parsed) out.push({ seq: d.js, at: new Date(row.ts).toISOString(), actorId: row.actorId, parsed });
  }
  return out;
}
