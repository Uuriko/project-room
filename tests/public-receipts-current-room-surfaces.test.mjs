// L3-D1 follow-up: the remaining public receipt surfaces for
// current-format (native) rooms — sitemap, collectPublicReceipts,
// the room proof page, directory receipt counts, and ?verify=1
// re-derivation.
//
// PR #6204 derived an opted-in current room's work-item receipts at
// read time for the receipts list and the single-receipt read only;
// the five surfaces named in its Root notes still read stored rows
// only, and a current room never writes stored rows — so its
// verified receipt was absent from the sitemap, the collected feed,
// its room's proof page and its workers' directory counts, and
// ?verify=1 reported its source record missing. These tests drive
// the same native-room fixture as
// tests/public-receipts-current-room.test.mjs (real store, synthetic
// room) and exercise each surface at the read-model level — the
// functions server/receipts-live.mjs passes through to the routes.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import {
  PUBLIC_READ_MODEL_SCHEMA,
  collectPublicReceipts,
  listPublicReceiptSitemap,
  publicReceiptById,
  publicWorkItemReceiptId,
  queryDirectoryEntries,
  rederivePublicReceipt,
  roomProofRows,
} from "../server/public-read-model.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";

const PERMISSIONS = ["accept_work", "complete_work", "verify", "decide"];
const WIR = publicWorkItemReceiptId("commons", "verified-task");
const UNVERIFIED_WIR = publicWorkItemReceiptId("commons", "unverified-task");

function baseStore(t) {
  const s = new RoomStore(":memory:");
  t.after(() => s.close());
  const events = initialRoom();
  for (const id of ["worker", "verifier"]) {
    events.push(event({ roomId: "commons", actorId: "owner", type: "member.added",
      data: { memberId: id, displayName: id, kind: "agent", permissions: PERMISSIONS } }));
  }
  s.initialize(events, { representation: "normalized-current-v1" });
  const keys = Object.fromEntries(["owner", "worker", "verifier"].map(id => [id, s.issueAccessKey("commons", id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], "commons", { id, type, data });
  const item = workId => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE room_id='commons' AND work_id=?").get(workId).body);
  return { s, keys, cmd, item };
}

function completeNative(cmd, item, { workId, title }) {
  cmd("owner", `propose-${workId}`, "work.proposed", { workItemId: workId, title,
    definitionOfDone: "Saved result", accountableMemberId: "worker", verifierMemberId: "verifier",
    independentVerificationRequired: true, ownerDecisionRequired: false, mode: "read" });
  cmd("worker", `accept-${workId}`, "work.accepted", { workItemId: workId, expectedRevision: 0 });
  const body = `Result body for ${workId}`;
  const post = cmd("worker", `result-${workId}`, "message.posted", { messageId: `result-${workId}`, body, workItemId: workId });
  return cmd("worker", `complete-${workId}`, "work.completed", { workItemId: workId,
    expectedRevision: item(workId).revision, evidenceKind: "room_text",
    evidenceMessageId: `result-${workId}`, evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(body), producerId: "worker", previousCompletionEventId: null,
    summary: `Summary for ${workId}`, nextAction: "Independent review" });
}

function verifiedFixture(t) {
  const f = baseStore(t);
  const completion = completeNative(f.cmd, f.item, { workId: "verified-task", title: "Verified native work" });
  const current = f.item("verified-task");
  f.cmd("verifier", "verify-verified-task", "verification.recorded", { workItemId: "verified-task",
    expectedRevision: current.revision, result: "pass",
    completionEventId: completion.event.id, evidenceVersion: current.receipt.evidenceVersion,
    summary: "Exact result checked" });
  // A second completion that is never verified is not a receipt and
  // must never be derived on any surface, opted in or not.
  completeNative(f.cmd, f.item, { workId: "unverified-task", title: "Unverified native work" });
  return f;
}

// A directory card for the worker's identity, with the member ->
// identity link a stored projection would have credited through.
// receipt_count starts at the stored-row count: zero, because a
// current room projects no rows.
function directoryFixture(t) {
  const f = verifiedFixture(t);
  f.s.db.exec(PUBLIC_READ_MODEL_SCHEMA);
  f.s.db.prepare(`INSERT INTO agent_identities (identity_id, secret_hash, display_name, created_at)
    VALUES ('identity-worker', 'fixture-secret-hash', 'worker', 0)`).run();
  f.s.db.prepare(`INSERT INTO identity_links (room_id, identity_id, member_id, linked_at)
    VALUES ('commons', 'identity-worker', 'worker', 0)`).run();
  f.s.db.prepare(`INSERT INTO public_directory_entries
    (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
    VALUES ('worker-card', 'worker', '', '[]', 'identity-worker', 0, 0, '2026-01-01T00:00:00.000Z')`).run();
  return f;
}

const directoryCountFor = (s, agentId) =>
  queryDirectoryEntries(s, {}).agents.find(agent => agent.agentId === agentId)?.receiptCount;

test("sitemap: opted-in current room's verified receipt is listed, unverified is not", async t => {
  const f = verifiedFixture(t);
  assert.ok(!listPublicReceiptSitemap(f.s).some(entry => entry.path === `/receipts/${WIR}`),
    "before the opt-in the sitemap holds no derived receipt");
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  const entries = listPublicReceiptSitemap(f.s);
  const hit = entries.find(entry => entry.path === `/receipts/${WIR}`);
  assert.ok(hit, `expected ${WIR} in sitemap ${JSON.stringify(entries.map(e => e.path))}`);
  assert.match(hit.lastmod, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!entries.some(entry => entry.path === `/receipts/${UNVERIFIED_WIR}`),
    "an unverified completion is not a receipt and must not be derived");
});

test("collectPublicReceipts: opted-in current room's verified receipt is collected", async t => {
  const f = verifiedFixture(t);
  assert.deepEqual(collectPublicReceipts(f.s), []);
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  const collected = collectPublicReceipts(f.s);
  const hit = collected.find(receipt => receipt.id === WIR);
  assert.ok(hit, `expected ${WIR} in ${JSON.stringify(collected.map(r => r.id))}`);
  assert.equal(hit.title, "Verified native work");
  assert.equal(hit.source, "work-item");
  assert.equal(hit.verification.state, "room_recorded");
  assert.ok(!collected.some(receipt => receipt.id === UNVERIFIED_WIR));
});

test("proof page: roomProofRows serves the opted-in current room's verified receipt", async t => {
  const f = verifiedFixture(t);
  assert.deepEqual(roomProofRows(f.s, "commons"), []);
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  const rows = roomProofRows(f.s, "commons");
  const hit = rows.find(receipt => receipt.id === WIR);
  assert.ok(hit, `expected ${WIR} in proof rows ${JSON.stringify(rows.map(r => r.id))}`);
  assert.equal(hit.title, "Verified native work");
  assert.ok(!rows.some(receipt => receipt.id === UNVERIFIED_WIR));
  assert.deepEqual(roomProofRows(f.s, "some-other-room"), [],
    "the derivation is attributed by origin room, not served under another room's proof page");
});

test("directory counts: the credited identity's card counts the derived receipt", async t => {
  const f = directoryFixture(t);
  assert.equal(directoryCountFor(f.s, "worker-card"), 0,
    "before the opt-in the derived receipt counts nowhere");
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  assert.equal(directoryCountFor(f.s, "worker-card"), 1,
    "the worker's identity is credited on the derived receipt, so its card counts it");
});

test("?verify=1: re-derivation resolves the derived receipt and verification passes", async t => {
  const f = verifiedFixture(t);
  assert.equal(rederivePublicReceipt(f.s, WIR), null,
    "before the opt-in there is nothing to re-derive");
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  const derived = rederivePublicReceipt(f.s, WIR);
  assert.ok(derived, "the derived receipt re-derives from its canonical source");
  assert.equal(derived.artifactHashOk, null);
  assert.equal(derived.row.id, WIR);
  assert.equal(derived.row.title, "Verified native work");
  assert.equal(derived.row.source, "work-item");
  assert.deepEqual(derived.row.hashes, [f.item("verified-task").receipt.evidenceVersion]);

  const receipt = publicReceiptById(f.s, WIR);
  assert.ok(receipt, "the receipt itself resolves (PR #6204)");
  const verdict = await verifyPublicReceipt(f.s, receipt, {
    fetchImpl: async () => { throw new Error("no network in this test"); },
  });
  const sourceCheck = verdict.checks.find(check => check.id === "source-record");
  assert.equal(sourceCheck.status, "pass", JSON.stringify(verdict.checks));
  assert.equal(verdict.verdict, "record-checked");
});

test("opt-out: every follow-up surface hides the current room's receipt again", async t => {
  const f = directoryFixture(t);
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  assert.ok(collectPublicReceipts(f.s).some(r => r.id === WIR));
  f.cmd("owner", "optout-1", "room.public_receipts_set", { enabled: false });
  assert.deepEqual(collectPublicReceipts(f.s), []);
  assert.ok(!listPublicReceiptSitemap(f.s).some(entry => entry.path === `/receipts/${WIR}`));
  assert.deepEqual(roomProofRows(f.s, "commons"), []);
  assert.equal(directoryCountFor(f.s, "worker-card"), 0);
  assert.equal(rederivePublicReceipt(f.s, WIR), null);
});
