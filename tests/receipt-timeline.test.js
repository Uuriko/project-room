// Replay timelines for public receipts (server/receipt-timeline.mjs).
//
// Behavior protected:
//   - a settled bounty lot replays in story order — posted, the
//     settlement verdict, then the lot's ledger movements in journal
//     order — driven by the real BountyEscrow state machine;
//   - proof-page entries replay from their own public fields (merged
//     before recorded; a public-work task's posted time precedes its
//     submission);
//   - the privacy invariant: a timeline exposes no actor, payload, or
//     timestamp the static views do not already serve for that receipt
//     (the one named exception is the public task's creation time, and
//     no identity or namespace from the public-work tables may ride
//     along with it);
//   - check state composes with a receipts-trust verdict by check id,
//     and no checks are invented when no verdict is supplied;
//   - the scrubber is fragment navigation on a script-free page — the
//     verdict renders first and the whole timeline works with no JS.
//
// Run: node --test tests/receipt-timeline.test.js
// (TMPDIR must be scratch-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { receiptJson } from "../server/receipts-page.mjs";
import { publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { publicWorkPostedAt, renderTimelineHtml, timelineForReceipt } from "../server/receipt-timeline.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// --- a real settled lot, driven through the escrow state machine ------------
const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };

function seedReadTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_directory_settings (
    room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0,
    public_receipts INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS room_public_settings (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS public_unpublish (kind TEXT, target TEXT);
  CREATE TABLE IF NOT EXISTS public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
}

function settledLotReceipt() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT replay_test");
    try { const out = fn(); db.exec("RELEASE replay_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO replay_test"); db.exec("RELEASE replay_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const keyPair = generateReceiptKeyPair();
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true,
    receipts: createReceiptSigner({ seedHex: keyPair.seedHex, ref: "test-operator" }) });
  escrow.ensureGenesis(ROOM);
  seedReadTables(db);
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "Write the migration guide",
    criteria: "C", amount: 10, deadline: new Date(nowMs + 3_600_000).toISOString(), approvalMode: "human" }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  const lotId = db.prepare("SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
    .get(ROOM, bounty.bountyId)?.lot_id;
  return publicReceiptById(store, lotId);
}

const leaves = (value, set = new Set()) => {
  if (typeof value === "string" || typeof value === "number") set.add(value);
  else if (Array.isArray(value)) for (const item of value) leaves(item, set);
  else if (value && typeof value === "object") for (const item of Object.values(value)) leaves(item, set);
  return set;
};
const STOP_KEYS = ["step", "type", "at", "actor", "detail", "checkIds", "checks"];

test("a settled lot replays posted → verified → its movements, in order", () => {
  const receipt = settledLotReceipt();
  assert.equal(receipt.source, "bounty-lot");
  const timeline = timelineForReceipt(receipt);
  assert.equal(timeline[0].type, "posted");
  assert.deepEqual(timeline[0].actor, { role: "poster", name: JILL });
  assert.equal(timeline[1].type, "verified");
  assert.equal(timeline[1].detail.settlement, receipt.lot.settlement.kind);
  const movements = timeline.slice(2);
  assert.equal(movements.length, receipt.lot.movements.length);
  assert.ok(movements.some(stop => stop.type === "settled" && stop.detail.kind === "payout"));
  assert.ok(movements.some(stop => stop.actor.role === "pool" && stop.detail.kind === "fee"));
  assert.ok(movements.filter(stop => stop.detail.kind === "payout").every(stop => stop.actor.role === "worker"));
  const times = timeline.map(stop => stop.at).filter(at => at !== null);
  assert.deepEqual(times, [...times].sort(), "stop timestamps never run backwards");
  assert.deepEqual(timeline.map(stop => stop.step), timeline.map((_, index) => index + 1));
});

test("privacy invariant: the replay exposes nothing the static record does not", () => {
  const receipt = settledLotReceipt();
  const served = leaves(receiptJson(receipt));
  for (const stop of timelineForReceipt(receipt)) {
    assert.ok(Object.keys(stop).every(key => STOP_KEYS.includes(key)), `unexpected stop field in ${JSON.stringify(stop)}`);
    if (stop.actor?.name) assert.ok(served.has(stop.actor.name), `actor ${stop.actor.name} is not in the static record`);
    if (stop.at) assert.ok(served.has(stop.at), `timestamp ${stop.at} is not in the static record`);
    for (const value of Object.values(stop.detail ?? {})) {
      assert.ok(served.has(value), `detail value ${value} is not in the static record`);
    }
  }
});

test("check state attaches from a receipts-trust verdict, by check id only", () => {
  const receipt = settledLotReceipt();
  assert.ok(timelineForReceipt(receipt).every(stop => !("checks" in stop)), "no verdict, no invented checks");
  const verification = { schema: "project-room-receipt-verification/1",
    checks: [{ id: "journal", status: "pass" }, { id: "pull-request", status: "pass" }] };
  const timeline = timelineForReceipt(receipt, { verification });
  assert.ok(timeline.every(stop => stop.checkIds.includes("journal")));
  assert.ok(timeline.every(stop => JSON.stringify(stop.checks) === JSON.stringify([{ id: "journal", status: "pass" }])),
    "only the journal check speaks to a lot's stops — the pull-request check stays off them");
});

test("bare receipt shapes replay only what their record carries", () => {
  assert.deepEqual(timelineForReceipt(null), []);
  assert.deepEqual(timelineForReceipt({ id: "wir_x", source: "work-item", at: "2026-10-11T00:00:00.000Z", agents: ["ada"], humans: [] })
    .map(stop => stop.type), ["recorded"]);
  const claim = { id: "wcr_x", source: "work-claim", at: "2026-10-10T00:00:00.000Z",
    mergedAt: "2026-10-10T00:00:00.000Z", pullRequest: "https://github.com/Uuriko/project-room/pull/1", agents: ["ada"], humans: [], hashes: [] };
  const timeline = timelineForReceipt(claim);
  assert.deepEqual(timeline.map(stop => stop.type), ["merged", "recorded"]);
  assert.deepEqual(timeline[0].checkIds, ["pull-request", "source-record"]);
  assert.equal(timeline[0].detail.pullRequest, claim.pullRequest);
  assert.equal(renderTimelineHtml([], "wcr_x"), "");
});

// --- the served pages ---------------------------------------------------------
const WCR = `wcr_${"ab".repeat(16)}`;
const PWR = `pwr_${"ef".repeat(16)}`;
const POSTED_MS = Date.parse("2026-10-09T00:00:00.000Z");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "replay-viewer-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "commons", "Commons", "A room that publishes its work.", 0, 1, "[]", "[]", "[]", 1, "request", null, "owner", now, now);
  const insert = (row) => store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.title, row.source, "commons", "commons", "Commons", JSON.stringify(["ada"]), "[]",
    row.pullRequest ?? null, row.mergedAt ?? null, JSON.stringify(row.hashes ?? []), row.at,
    "https://room.trydemigod.com/?start=room");
  insert({ id: WCR, title: "Merged fix for the parser", source: "work-claim",
    pullRequest: "https://github.com/Uuriko/project-room/pull/123", mergedAt: "2026-10-10T00:00:00.000Z",
    hashes: [`sha256:${"a".repeat(64)}`], at: "2026-10-10T00:00:00.000Z" });
  insert({ id: PWR, title: "Public audit delivered", source: "public-work",
    hashes: [`sha256:${"b".repeat(64)}`], at: "2026-10-12T00:00:00.000Z" });
  store.db.exec(publicWorkClaimsSchema);
  store.db.prepare("INSERT INTO public_work_tasks VALUES (?,?,?,?,?,?,?,?,?)")
    .run("offer-1", "commons", "commons", 1, "https://example.com/repo", "main", "[]", 0, POSTED_MS);
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(PWR, "offer-1", "commons", 0, "id:agent/scout", "delivered", "b".repeat(64), 9, "{}", POSTED_MS + 1000);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, store };
}

test("proof twin and pages carry the replay; the verdict still comes first", async t => {
  const { origin, store } = await serve(t);
  assert.equal(publicWorkPostedAt(store, PWR), new Date(POSTED_MS).toISOString());

  const doc = await (await fetch(`${origin}/r/commons/proof.json`)).json();
  const byId = new Map(doc.entries.map(entry => [entry.id, entry]));
  assert.deepEqual(byId.get(WCR).timeline.map(stop => stop.type), ["merged", "recorded"]);
  assert.deepEqual(byId.get(PWR).timeline.map(stop => stop.type), ["posted", "submitted"]);
  assert.equal(byId.get(PWR).timeline[0].at, new Date(POSTED_MS).toISOString());
  assert.ok(!JSON.stringify(byId.get(PWR).timeline).includes("id:agent/scout"),
    "the public-work identity id never rides into the replay");
  assert.ok(!JSON.stringify(byId.get(PWR).timeline).includes("namespace"));

  const page = await (await fetch(`${origin}/r/commons/proof`)).text();
  assert.ok(!page.includes("<script"), "the proof page stays script-free");
  assert.ok(page.indexOf("Server-verified merge") < page.indexOf(`id="t-${WCR}-0"`),
    "the verdict renders before the first replay stop");
  assert.ok(page.includes(`href="#t-${WCR}-1"`), "stops deep-link by fragment");
  assert.ok(page.includes("Step 1 of 2"));

  const detail = await (await fetch(`${origin}/receipts/${WCR}.json`)).json();
  assert.deepEqual(detail.timeline.map(stop => stop.type), ["merged", "recorded"]);
  const detailHtml = await (await fetch(`${origin}/receipts/${WCR}`)).text();
  assert.ok(detailHtml.includes("Replay"));
  assert.ok(detailHtml.indexOf("What this record proves") > detailHtml.indexOf(`id="t-${WCR}-0"`),
    "the replay sits below the record it replays");
});
