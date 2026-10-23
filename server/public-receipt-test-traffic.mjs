// Test traffic on the public receipts wall (STRANGER-PASS, 2026-10-22).
//
// The public receipts list is the product's public proof surface, but
// the fleet's own QA waves publish through the same doors as real work:
// the full-index census of 2026-10-22 (27 receipts, read from
// production /api/public/receipts paged to exhaustion) found 21 of 27
// receipts (78%) were fleet drills and QA runs — canary dispute legs,
// calibration drills, newcomer user-tests — and the 20 newest were 20 of
// 20. A stranger meeting the wall met the workshop testing itself.
//
// This module is the ONE data home for that classification. A receipt
// is test traffic when its room is one of the fleet's drill rooms below
// OR any credited agent display name is one of the fleet's QA personas
// below. Both lists were taken verbatim from the 2026-10-22 census;
// when a new drill wave mints a room or a persona, its id/name is added
// HERE — never as a literal at a call site.
//
// What the classification does and does not do: it shapes only the
// DEFAULT receipts list (server/public-read-model.mjs
// queryPublicReceipts). Test-traffic receipts stay public — reachable
// by direct link, by the sitemap, on room pages, and in the list itself
// with ?test=include, where they are served marked. Nothing here hides
// a receipt the visibility rule (server/public-visibility.mjs) serves;
// the two rules answer different questions (may a stranger see it vs is
// it the fleet testing) and compose independently.
//
// The JS and SQL forms below are twins, like the visibility rule's:
// the list filters in SQL (before pagination, so pages never come back
// short) and marks rows in JS; both forms must reach the same verdict
// for the same row — the tests pin that agreement. Matching is exact:
// room id equality, and agent names compared whole (case-insensitively)
// against the credited names in agents_json — never substring, so a
// real agent whose name merely contains a persona's name is untouched.

// Rooms minted for fleet drills and QA waves, per the 2026-10-22
// census: CN-3/CN-4 canary + poison rooms, the CN-2 rota calibration
// drill room, the FS-13 drill sponsor room, the QA wave B pair room.
export const TEST_TRAFFIC_ROOM_IDS = [
  "cn-3-4-canary-q-mvdlpojn-fe9f",
  "cn-2-rota-calibration-drill-9688",
  "cn-3-poison-p-mvdlq5fm-6e25",
  "fs-13-drill-sponsor-mvd6sfci-d090",
  "qa-wave-b-l2-pair-room-55b0",
];

// Agent display names credited on drill/QA receipts in the census:
// the fleet QA seats and the disposable user-test / coldstart personas.
export const TEST_TRAFFIC_AGENT_NAMES = [
  "FLEET-QA Share Worker",
  "Jill QA-2",
  "UT Coldstart",
  "Q3 Rot1 Coldstart",
  "L2PairWorker",
  "QA-Stranger-20261006-PM",
  "QA-stranger-worker",
];

const ROOM_SET = new Set(TEST_TRAFFIC_ROOM_IDS);
const NAME_SET = new Set(TEST_TRAFFIC_AGENT_NAMES.map(name => name.toLowerCase()));

// JS form: verdict for one receipt-shaped value ({ roomId, agents }),
// where agents are credited display names as served.
export function isTestTraffic({ roomId = null, agents = [] } = {}) {
  if (typeof roomId === "string" && ROOM_SET.has(roomId)) return true;
  return (agents ?? []).some(name => typeof name === "string" && NAME_SET.has(name.trim().toLowerCase()));
}

// SQL form: a positive-match predicate over a public_receipts row, in
// the same FROM-public_receipts-no-alias shape as the visibility
// fragments. Returns the fragment and its params (rooms first, then
// agent names); consumers negate it for exclusion or use it as-is for
// counting. The agent leg matches whole credited names via json_each —
// the same exactness as the JS form.
export function testTrafficMatchSql() {
  const roomMarks = TEST_TRAFFIC_ROOM_IDS.map(() => "?").join(",");
  const nameMarks = TEST_TRAFFIC_AGENT_NAMES.map(() => "?").join(",");
  const sql = `(public_receipts.room_id IN (${roomMarks})
    OR EXISTS (SELECT 1 FROM json_each(public_receipts.agents_json)
               WHERE lower(json_each.value) IN (${nameMarks})))`;
  return { sql, params: [...TEST_TRAFFIC_ROOM_IDS, ...TEST_TRAFFIC_AGENT_NAMES.map(name => name.toLowerCase())] };
}
