// STRANGER-PASS: test traffic (the fleet's own drills and QA runs) is
// off the DEFAULT public receipts list, counted and disclosed, and
// served marked with test=include. The receipts stay public — detail
// reads and the sitemap are untouched by this filter — and the SQL
// exclusion and the JS marker must agree on every row (the twin rule,
// same discipline as the visibility predicate).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts, publicReceiptById, listPublicReceiptSitemap } from "../server/public-read-model.mjs";
import { receiptsListJson, renderReceiptsHtml } from "../server/receipts-page.mjs";
import { isTestTraffic, TEST_TRAFFIC_ROOM_IDS, TEST_TRAFFIC_AGENT_NAMES } from "../server/public-receipt-test-traffic.mjs";

const CANARY = "cn-3-4-canary-q-mvdlpojn-fe9f"; // in TEST_TRAFFIC_ROOM_IDS
const hex = (ch, n) => ch.repeat(n);
// Newest first by `at`. Drill and real rows interleave on purpose:
// default pagination must never return a short page.
const ROWS = [
  { id: `pwr_${hex("a", 64)}`, title: "Drill by room", source: "public-work", roomId: CANARY, agents: ["Some Worker"], at: "2026-10-06T00:00:00.000Z" },
  { id: `pwr_${hex("b", 64)}`, title: "Real garden work", source: "public-work", roomId: "public-work-garden", agents: ["zai_glm"], at: "2026-10-05T00:00:00.000Z" },
  { id: `wir_${hex("c", 32)}`, title: "Drill by agent, no room", source: "work-item", roomId: null, agents: ["FLEET-QA Share Worker"], at: "2026-10-04T00:00:00.000Z" },
  { id: `wcr_${hex("d", 32)}`, title: "Real PR work", source: "work-claim", roomId: "commons", agents: ["Member Dev"], pullRequest: "https://github.com/Uuriko/project-room/pull/1", at: "2026-10-03T00:00:00.000Z" },
  { id: `pwr_${hex("e", 64)}`, title: "Drill by agent", source: "public-work", roomId: "public-work-garden", agents: ["Jill QA-2"], at: "2026-10-02T00:00:00.000Z" },
  { id: `pwr_${hex("f", 64)}`, title: "Real commons work", source: "public-work", roomId: "commons", agents: ["Another Dev"], at: "2026-10-01T00:00:00.000Z" },
];
const DRILL_IDS = [ROWS[0].id, ROWS[2].id, ROWS[4].id];
const REAL_TITLES = ["Real garden work", "Real PR work", "Real commons work"];

function serve(t, rows = ROWS) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "test-traffic-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const insert = store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(row.id, row.title, row.source, row.roomId, row.roomId, null, JSON.stringify(row.agents), "[]",
      row.pullRequest ?? null, row.pullRequest ? row.at : null, null, "[]", row.at, "/?start=room", "[]");
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("the data module names the census lists and matches exactly", () => {
  assert.ok(TEST_TRAFFIC_ROOM_IDS.includes(CANARY));
  assert.ok(TEST_TRAFFIC_AGENT_NAMES.includes("Jill QA-2"));
  assert.equal(isTestTraffic({ roomId: CANARY, agents: ["Anyone"] }), true);
  assert.equal(isTestTraffic({ roomId: null, agents: ["jill qa-2"] }), true); // whole name, case-insensitive
  assert.equal(isTestTraffic({ roomId: null, agents: ["Jill QA-2 Fan"] }), false); // never substring
  assert.equal(isTestTraffic({ roomId: "public-work-garden", agents: ["zai_glm"] }), false);
  assert.equal(isTestTraffic({ roomId: null, agents: [] }), false);
});

test("default list excludes test traffic and counts it, with no short pages", t => {
  const store = serve(t);
  const page = queryPublicReceipts(store, { limit: 2 });
  assert.deepEqual(page.receipts.map(r => r.title), REAL_TITLES.slice(0, 2));
  assert.equal(page.nextCursor, ROWS[3].id);
  assert.deepEqual(page.testTraffic.included, false);
  assert.equal(page.testTraffic.hiddenCount, 3);
  const rest = queryPublicReceipts(store, { limit: 2, cursor: page.nextCursor });
  assert.deepEqual(rest.receipts.map(r => r.title), REAL_TITLES.slice(2));
  assert.equal(rest.nextCursor, null);
});

test("test=include serves everything, test rows marked, SQL and JS twins agree", t => {
  const store = serve(t);
  const page = queryPublicReceipts(store, { limit: 50, test: "include" });
  assert.equal(page.receipts.length, ROWS.length);
  assert.equal(page.testTraffic.included, true);
  assert.equal(page.testTraffic.hiddenCount, 0);
  for (const pub of page.receipts) {
    const jsVerdict = isTestTraffic({ roomId: pub.room?.id ?? null, agents: pub.agents });
    assert.equal(pub.testTraffic === true, jsVerdict, `${pub.id}: marker must equal the JS verdict`);
    assert.equal(DRILL_IDS.includes(pub.id), jsVerdict, `${pub.id}: census expectation`);
  }
  // And the default list's membership is the same verdict, negated.
  const def = queryPublicReceipts(store, { limit: 50 });
  assert.deepEqual(def.receipts.map(r => r.id), ROWS.filter(r => !DRILL_IDS.includes(r.id)).map(r => r.id));
});

test("a test receipt is not a default-view cursor but anchors the include view", t => {
  const store = serve(t);
  const viaDefault = queryPublicReceipts(store, { cursor: ROWS[0].id, limit: 10 });
  assert.equal(viaDefault.error?.status, 422);
  assert.equal(viaDefault.error?.code, "invalid_receipt_query");
  const viaInclude = queryPublicReceipts(store, { cursor: ROWS[0].id, limit: 10, test: "include" });
  assert.equal(viaInclude.error, undefined);
  assert.equal(viaInclude.receipts.length, ROWS.length - 1);
});

test("an invalid test value is refused like any bad list query", t => {
  const store = serve(t);
  const page = queryPublicReceipts(store, { test: "only" });
  assert.equal(page.error?.status, 422);
  assert.equal(page.error?.code, "invalid_receipt_query");
});

test("room and agent filters compose with the exclusion and its count", t => {
  const store = serve(t);
  const byRoom = queryPublicReceipts(store, { room: CANARY });
  assert.deepEqual(byRoom.receipts, []);
  assert.equal(byRoom.testTraffic.hiddenCount, 1);
  const byRoomAll = queryPublicReceipts(store, { room: CANARY, test: "include" });
  assert.deepEqual(byRoomAll.receipts.map(r => r.title), ["Drill by room"]);
  const byAgent = queryPublicReceipts(store, { agent: "qa-2" });
  assert.deepEqual(byAgent.receipts, []);
  assert.equal(byAgent.testTraffic.hiddenCount, 1);
});

test("test receipts stay reachable: detail read and sitemap are unfiltered", t => {
  const store = serve(t);
  const detail = publicReceiptById(store, ROWS[0].id);
  assert.equal(detail?.title, "Drill by room");
  assert.equal(detail?.testTraffic, undefined); // the marker is a list-view fact, never a detail field
  const sitemap = listPublicReceiptSitemap(store);
  assert.ok(sitemap.some(entry => entry.path === `/receipts/${ROWS[0].id}`));
});

test("list JSON carries the summary and the marker only in include mode", t => {
  const store = serve(t);
  const def = receiptsListJson(queryPublicReceipts(store, { limit: 50 }));
  assert.deepEqual(def.testTraffic, { included: false, hiddenCount: 3 });
  assert.ok(def.receipts.every(r => !("testTraffic" in r)));
  const inc = receiptsListJson(queryPublicReceipts(store, { limit: 50, test: "include" }));
  assert.deepEqual(inc.testTraffic, { included: true, hiddenCount: 0 });
  assert.equal(inc.receipts.find(r => r.id === ROWS[0].id)?.testTraffic, true);
  assert.ok(!("testTraffic" in inc.receipts.find(r => r.id === ROWS[1].id)));
});

test("HTML wall: default view discloses the hidden count, include view marks the cards", t => {
  const store = serve(t);
  const def = renderReceiptsHtml(queryPublicReceipts(store, { limit: 50 }));
  for (const title of REAL_TITLES) assert.ok(def.includes(title), `default view shows ${title}`);
  assert.ok(!def.includes("Drill by room"));
  assert.ok(def.includes("3 test-traffic receipts"));
  assert.ok(def.includes('href="/receipts?test=include"'));
  const inc = renderReceiptsHtml(queryPublicReceipts(store, { limit: 50, test: "include" }));
  assert.ok(inc.includes("Drill by room"));
  assert.ok(inc.includes("Test traffic")); // the per-card mark
  assert.ok(inc.includes("Showing all receipts, including test traffic"));
  assert.ok(inc.includes('href="/receipts"')); // the way back
});

test("an all-test index reads truthfully in the default view, not as an empty wall", t => {
  const store = serve(t, [ROWS[0], ROWS[4]]);
  const html = renderReceiptsHtml(queryPublicReceipts(store, { limit: 50 }));
  assert.ok(html.includes("everything currently published is test traffic"));
  assert.ok(!html.includes("No published receipts yet"));
});
