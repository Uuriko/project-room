// FIX-29: write-budget measurement for 200-agent heartbeat + event traffic.
//
// The playbook ships with numbers, not guesses: the per-credential write
// budget is enforced by rate(`write:${credentialHash}`, 60) in
// server/http.mjs (1-minute window). This probe measures, against a live
// server, how many writes one member token can actually spend per minute on
// the heartbeat path (POST /work-claims/:id/renew) and the event-append path
// (POST /commands), proves the buckets are per-credential (a flooded token
// never 429s a sibling), and pins the SLO inputs: heartbeat cadence vs the
// 60/min budget, the 1M room event budget, the 10% reserve, the 60s renew
// coalesce, and the 100 members/room ceiling (200 agents span >= 2 rooms).
//
// Written fail-first: the first assertions below pin the DOCUMENTED budget
// (60/min). If the enforced budget changes, the measurement fails loudly and
// the SLO numbers must be re-measured before docs are touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { CLAIM_EVENT_COALESCE_MS } from "../server/work-claim-events.mjs";

// Documented (server/http.mjs) per-credential write budget: 60/min.
const DOCUMENTED_WRITE_BUDGET_PER_MIN = 60;
// Playbook: PHOENIX heartbeat math ≈ 3 writes/s at 200 agents.
const HEARTBEAT_WRITES_PER_SEC = 3;
const HEARTBEAT_AGENTS = 200;

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind: "agent", permissions }
  });
  add("hb1", "Heartbeat One", ["accept_work", "complete_work"]);
  add("hb2", "Heartbeat Two", ["accept_work", "complete_work"]);
  add("hb3", "Heartbeat Three", ["accept_work", "complete_work"]);
  const hb1Key = store.issueAccessKey("commons", "hb1");
  const hb2Key = store.issueAccessKey("commons", "hb2");
  const hb3Key = store.issueAccessKey("commons", "hb3");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    // Read text first, then parse: a truncated stream must surface as a
    // visible parse failure, never a silent null.
    const text = await response.text();
    let value = null, parseError = null;
    try { value = JSON.parse(text); } catch (error) { parseError = String(error); }
    return { status: response.status, value, headers: response.headers, text, parseError };
  };
  const renew = (token, claimId) => call(token, `/work-claims/${claimId}/renew`, {});
  const postMessage = token => call(token, "/commands", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: "heartbeat ping" }
  });
  // One claim per heartbeat member so renew ownership always holds.
  for (const [token, claimId] of [[hb1Key, "w1"], [hb2Key, "w2"], [hb3Key, "w3"]]) {
    assert.equal((await call(token, "/work-claims", { id: claimId, title: `claim ${claimId}` })).status, 201, `create ${claimId}`);
    assert.equal((await call(token, `/work-claims/${claimId}/claim`, {})).status, 200, `claim ${claimId}`);
    assert.equal((await renew(token, claimId)).status, 200, `first renew ${claimId}`);
  }
  return { store, call, renew, postMessage, hb1Key, hb2Key, hb3Key };
}

// Fire renews until the first non-200; return the count that passed plus the
// full refusal trail (status + code) so a flaky mid-loop refusal is visible.
async function renewsUntil429(renew, token, claimId, cap = 200) {
  let passed = 0;
  const refusals = [];
  for (let i = 0; i < cap; i++) {
    const response = await renew(token, claimId);
    if (response.status === 200) { passed++; continue; }
    refusals.push({ status: response.status, code: response.value?.error?.code, at: passed, response });
    break;
  }
  return { passed, firstRefusal: refusals[0]?.response ?? null, refusals };
}

test("FIX-29: the heartbeat path spends exactly the documented write budget — 60/min per credential", async t => {
  const { renew, hb1Key } = await fixture(t);
  // One renew was already spent in the fixture; 59 more should pass, then 429.
  // The fixture already spent 3 writes on hb1 (create + claim + renew), so
  // exactly 60 - 3 = 57 more renews pass before the budget is spent.
  const { passed, firstRefusal, refusals } = await renewsUntil429(renew, hb1Key, "w1");
  assert.equal(passed, DOCUMENTED_WRITE_BUDGET_PER_MIN - 3,
    `expected ${DOCUMENTED_WRITE_BUDGET_PER_MIN - 3} further renews before the budget is spent, got ${passed} (refusals: ${JSON.stringify(refusals)})`);
  assert.ok(firstRefusal, "the 61st write in the window must be refused");
  assert.equal(firstRefusal.status, 429);
  assert.equal(firstRefusal.parseError, null,
    `the 429 body must be JSON (raw: ${JSON.stringify(firstRefusal.text.slice(0, 200))})`);
  assert.equal(firstRefusal.value?.error?.code, "rate_limited");
  assert.equal(Number(firstRefusal.headers.get("x-ratelimit-limit")), DOCUMENTED_WRITE_BUDGET_PER_MIN,
    "the refusal names the 60/min write budget");
  assert.ok(firstRefusal.headers.get("retry-after") ?? firstRefusal.headers.get("Retry-After"),
    "the refusal carries a Retry-After so clients can back off");
});

test("FIX-29: write buckets are per-credential — an exhausted token never 429s a sibling", async t => {
  const { renew, hb1Key, hb2Key } = await fixture(t);
  await renewsUntil429(renew, hb1Key, "w1"); // flood hb1 until 429
  const sibling = await renew(hb2Key, "w2");
  assert.equal(sibling.status, 200, "a sibling credential still has its own full 60/min budget");
  // Fixture spent 3 on hb2 plus the sibling check above: 56 more renews, then 429.
  const { passed } = await renewsUntil429(renew, hb2Key, "w2");
  assert.equal(passed, DOCUMENTED_WRITE_BUDGET_PER_MIN - 4,
    "the sibling spends its own independent 60/min budget");
});

test("FIX-29: heartbeat and event-append paths share one per-credential budget, one token per request", async t => {
  const { renew, postMessage, hb3Key } = await fixture(t);
  // Fixture spent 3 on hb3; 56 renews + 1 event append = 60 spent, so the
  // 61st write (on either path) must 429. If the paths had separate buckets,
  // or a request cost != 1 token, the final request would pass.
  for (let i = 0; i < DOCUMENTED_WRITE_BUDGET_PER_MIN - 4; i++) {
    assert.equal((await renew(hb3Key, "w3")).status, 200, `renew ${i}`);
  }
  const appended = await postMessage(hb3Key);
  assert.equal(appended.status, 201, "the event-append path spends from the same budget");
  const over = await renew(hb3Key, "w3");
  assert.equal(over.status, 429, "the 61st write across both paths is refused");
});

test("FIX-29: SLO inputs — heartbeat cadence fits the measured budget with wide headroom", async t => {
  const writesPerMinPerToken = (HEARTBEAT_WRITES_PER_SEC * 60) / HEARTBEAT_AGENTS; // 0.9
  assert.ok(writesPerMinPerToken < 1, "sanity: 200 agents at 3 writes/s ≈ 0.9 writes/min/token");
  const headroom = DOCUMENTED_WRITE_BUDGET_PER_MIN / writesPerMinPerToken;
  assert.ok(headroom >= 10, `measured budget gives ${headroom.toFixed(1)}× headroom over the heartbeat cadence (need ≥10×)`);
});

test("FIX-29: SLO inputs — room event budget, reserve, coalesce and member ceiling are pinned", async t => {
  // The room event budget is a LIFETIME cap (1M events), not a rate: at the
  // heartbeat write rate the 10% reserve starts 409ing non-privileged Board
  // writes in ~3.5 days and the hard cap hits in ~3.9 days. That is the
  // binding constraint for sustained 200-agent traffic — not the per-token
  // write budget.
  assert.equal(PILOT_LIMITS.eventsPerRoom, 1_000_000, "room lifetime event budget");
  const reserveEvents = PILOT_LIMITS.eventsPerRoom * 0.10; // assertBoardEventBudget reserve
  const daysToReserve = (PILOT_LIMITS.eventsPerRoom - reserveEvents) / HEARTBEAT_WRITES_PER_SEC / 86400;
  const daysToCap = PILOT_LIMITS.eventsPerRoom / HEARTBEAT_WRITES_PER_SEC / 86400;
  assert.ok(daysToReserve > 3 && daysToReserve < 4, `reserve reached in ~${daysToReserve.toFixed(2)} days at 3 writes/s`);
  assert.ok(daysToCap > 3.5 && daysToCap < 4.5, `hard cap reached in ~${daysToCap.toFixed(2)} days at 3 writes/s`);
  // Heartbeat renews coalesce to at most one room event per claim per minute.
  assert.equal(CLAIM_EVENT_COALESCE_MS, 60_000, "renew event coalesce window");
  // 200 agents cannot share one room: they span >= 2 rooms.
  assert.equal(PILOT_LIMITS.membersPerRoom, 100, "members per room ceiling");
});
