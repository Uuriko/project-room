// Delivery evidence in project state: a deploy/merge/CI receipt is text a member
// posted. It is kept as a report with its provenance, never promoted to a
// verified delivery fact, and the Room service's own build is never compared
// with a receipt for the project being developed. Real stored posts (acceptance
// fixture, journal + typed log) feed the production reader and builder.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { buildProjectState, readProjectState, PROJECT_STATE_MAX_BYTES } from "../server/project-state.mjs";
import { readReceiptSignals } from "../server/receipt-signals.mjs";

const ROOM = "commons";
const FULL = "234527c7" + "a".repeat(32); // the Room service's own stamped revision
const DEPLOY_OK = "PROD DEPLOY 234527c7 · strict smoke success · live smoke success · https://deploy.example/run/1";

function setup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const member = f.store.identities.create("Ordinary member");
  linkWithProof(f.store, f.keys.owner, ROOM, member, { memberId: "member", displayName: "Ordinary member", permissions: ["accept_work", "complete_work"] });
  const post = (key, body, extra = {}) => f.store.command(key, ROOM, { id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body, ...extra } });
  return { f, member, post, read: key => readProjectState(f.store, key, ROOM) };
}
// Builder input from what was really stored: the typed receipt log the reader prefers.
const stored = f => (readReceiptSignals(f.store.db, ROOM) ?? []).map(r => ({ seq: r.seq, at: r.at, actorId: r.actorId, body: null, parsed: r.parsed }));
const base = (over = {}) => ({ roomId: ROOM, viewerId: "owner", ownerId: "owner", sequence: 99, now: Date.UTC(2026, 10, 16, 12), items: [], itemsComplete: true,
  members: { member: { displayName: "Ordinary member", kind: "agent" }, owner: { displayName: "Owner", kind: "human" } }, attention: [], live: { sourceRevision: FULL, buildId: "2026-11-16T10:00:00.000Z" }, ...over });
const at = n => new Date(Date.UTC(2026, 10, 16, 9, n)).toISOString();
const rcpt = (seq, body, actorId = "member") => ({ seq, at: at(seq), actorId, body });

test("1: a receipt-shaped post by an ordinary member is a report, never a confirmed deploy, even when its sha matches the Room build", t => {
  const { member, post, f } = setup(t);
  post(member.secret, DEPLOY_OK);
  const s = buildProjectState(base({ receipts: stored(f) }));
  assert.notEqual(s.live?.smoke, "ok", "a posted line is not a smoke result");
  assert.equal(s.live?.deployedAt ?? null, null, "a post time is not a deploy time");
  assert.notEqual(s.delivery?.verified, true);
  const row = s.receipts.find(r => r.kind === "deploy");
  assert.equal(row.by, "Ordinary member", "provenance retained");
  assert.equal(row.evidence, "member-reported");
});

test("2: a receipt for another repository does not create a mismatch against the Room service build (stamped or unstamped)", t => {
  const { member, post, f, read } = setup(t);
  post(member.secret, DEPLOY_OK);
  for (const live of [{ sourceRevision: "f".repeat(40), buildId: "2026-11-16T10:00:00.000Z" }, { sourceRevision: "unstamped", buildId: "unstamped" }]) {
    const s = buildProjectState(base({ live, receipts: stored(f) }));
    assert.doesNotMatch(JSON.stringify(s), /differs|mismatch/i, JSON.stringify(live));
  }
  const unstamped = read(f.keys.owner); // the real reader in a dev (unstamped) service
  assert.doesNotMatch(JSON.stringify(unstamped), /differs|mismatch/i);
  assert.equal(unstamped.roomService.revision, null);
});

test("2b: the Room service build is labelled as the service and keeps its full revision", () => {
  const s = buildProjectState(base({ receipts: [rcpt(10, DEPLOY_OK)] }));
  assert.equal(s.roomService.revision, FULL);
  assert.equal(s.roomService.build, "2026-11-16T10:00:00.000Z");
  assert.ok(!JSON.stringify(s.delivery).includes(FULL), "delivery never carries the Room service revision");
  assert.equal(s.delivery.deploy.shaPrefix, "234527c7", "delivery names only what the receipt said");
  for (const bad of ["unstamped", "ABC", "g".repeat(40), null, 12]) assert.equal(buildProjectState(base({ live: { sourceRevision: bad, buildId: null } })).roomService.revision, null, String(bad));
});

test("3: absent or ambiguous environment/format yields no delivery claim at all", t => {
  const { member, post, f, read } = setup(t);
  for (const body of ["DEPLOY 234527c7 · smoke success", "deployed 234527c7 to staging, smoke ok", "PROD DEPLOYED 234527c7 · success", "prod deploy 234527c7 · strict smoke success", "PROD DEPLOY 234527 · smoke success"]) post(member.secret, body);
  for (const s of [buildProjectState(base({ receipts: stored(f) })), read(f.keys.owner)]) {
    assert.equal(s.delivery.status, "unknown");
    assert.equal(s.delivery.deploy, null);
    assert.deepEqual(s.receipts, []);
  }
});

test("4: an 8-hex prefix is not commit identity: a merge report posted after a deploy report is not treated as covered by it", () => {
  const receipts = [rcpt(10, DEPLOY_OK), rcpt(20, "MERGED #1 234527c7 · same prefix, possibly a different commit")];
  const s = buildProjectState(base({ receipts }));
  assert.equal(s.mergedNotDeployed, undefined, "no precomputed undeployed verdict");
  assert.deepEqual(s.delivery.mergesPostedAfterDeployReport.items.map(i => i.pr), [1]);
  assert.equal(s.delivery.mergesPostedAfterDeployReport.items[0].shaPrefix, "234527c7");
});

test("5: conflicting or out-of-order reports are shown as reports; a later rollback or failure does not leave an older OK as the current state", () => {
  const rolled = buildProjectState(base({ receipts: [rcpt(10, DEPLOY_OK), rcpt(20, "PROD ROLLBACK · smoke ok")] }));
  assert.notEqual(rolled.live?.smoke, "ok", "build matches the older ok report, but a rollback was reported after it");
  assert.equal(rolled.delivery.deploy.kind, "rollback");
  assert.equal(rolled.delivery.lastReportedOk.shaPrefix, "234527c7", "the earlier report stays visible");
  const failed = buildProjectState(base({ receipts: [rcpt(10, DEPLOY_OK), rcpt(20, "PROD DEPLOY 99999999 · ROLL FORWARD REQUIRED · smoke failure")] }));
  assert.equal(failed.delivery.deploy.reportedSmoke, "failed");
  assert.equal(failed.delivery.lastReportedOk.shaPrefix, "234527c7");
  assert.notEqual(failed.live?.smoke, "ok");
  // Older sha reported after a newer one: posting order is shown as such, no "current" or "deployedAt" is derived from it.
  const shuffled = buildProjectState(base({ receipts: [rcpt(10, DEPLOY_OK.replace("234527c7", "bbbbbbbb")), rcpt(20, DEPLOY_OK)] }));
  assert.equal(shuffled.delivery.deploy.postedAt, at(20));
  assert.equal(shuffled.live?.deployedAt ?? null, null);
  assert.doesNotMatch(JSON.stringify(shuffled), /deployedAt|"current"/);
});

test("6: no receipts leaves delivery unknown, not healthy, failed or zero", () => {
  const s = buildProjectState(base({ receipts: [] }));
  assert.equal(s.delivery.status, "unknown");
  assert.equal(s.delivery.deploy, null);
  assert.equal(s.delivery.mergesPostedAfterDeployReport.count, null);
  assert.equal(s.live?.smoke ?? null, null);
  const mergesOnly = buildProjectState(base({ receipts: [rcpt(10, "MERGED #3 cccccccc · only a merge")] }));
  assert.equal(mergesOnly.delivery.status, "unknown");
  assert.equal(mergesOnly.delivery.mergesPostedAfterDeployReport.count, null, "no deploy report: undeployed is unknown, not zero and not one");
});

test("7: a valid member report keeps its text, source position and author without an authority upgrade", t => {
  const { member, post, f, read } = setup(t);
  post(member.secret, DEPLOY_OK);
  post(member.secret, "MERGED #6240 53e4ecbb · tighten receipts");
  const s = read(f.keys.owner);
  const deploy = s.receipts.find(r => r.kind === "deploy"), merged = s.receipts.find(r => r.kind === "merged");
  assert.equal(deploy.by, "Ordinary member");
  assert.ok(Number.isInteger(deploy.seq) && Date.parse(deploy.postedAt) > 0);
  assert.equal(deploy.shaPrefix, "234527c7");
  assert.deepEqual([merged.pr, merged.title, merged.shaPrefix], [6240, "tighten receipts", "53e4ecbb"]);
  assert.ok(s.receipts.every(r => r.evidence === "member-reported"));
  assert.equal(s.delivery.verified, false);
  assert.equal(s.delivery.status, "reported");
  assert.equal(s.delivery.deploy.by, "Ordinary member");
  assert.equal(s.delivery.deploy.reportedSmoke, "ok");
  assert.deepEqual(s.delivery.mergesPostedAfterDeployReport.items.map(i => i.pr), [6240]);
});

test("8: the only observed fact is the Room service's own stamped build; no project delivery fact is observed today", () => {
  const s = buildProjectState(base({ receipts: [rcpt(10, DEPLOY_OK), rcpt(20, "MERGED #1 53e4ecbb · x"), rcpt(30, "CI #1 53e4ecbb PASSED 3/3 jobs")] }));
  assert.deepEqual(Object.keys(s.roomService).sort(), ["build", "revision"]);
  assert.doesNotMatch(JSON.stringify(s), /"verified":true|"confirmed"|"observed"/, "no receipt kind has an independent source today, so nothing may be upgraded");
});

test("9a: private receipt text never reaches project state", t => {
  const { f, member, post, read } = setup(t);
  post(f.keys.owner, "PROD DEPLOY aaaaaaaa · strict smoke success · live smoke success PRIVATE-SENTINEL", { toMemberId: "producer" });
  assert.doesNotMatch(JSON.stringify(read(member.secret)), /PRIVATE-SENTINEL|aaaaaaaa/);
  assert.equal(read(member.secret).receipts.length, 0);
});

test("9b: a deleted receipt post is not resurrected as a delivery claim", t => {
  const { f, member, post, read } = setup(t);
  post(f.keys.owner, DEPLOY_OK); // a good deploy anchor makes the reader use the typed receipt log, which outlives the post's body
  const doomed = crypto.randomUUID();
  f.store.command(member.secret, ROOM, { id: crypto.randomUUID(), type: "message.posted", data: { messageId: doomed, body: "MERGED #77 deadbeef · DELETED-SENTINEL" } });
  assert.match(JSON.stringify(read(f.keys.owner)), /DELETED-SENTINEL/, "fixture: visible before deletion");
  f.store.command(member.secret, ROOM, { id: crypto.randomUUID(), type: "message.deleted", data: { messageId: doomed, expectedMessageRevision: 0 } });
  assert.doesNotMatch(JSON.stringify(read(f.keys.owner)), /DELETED-SENTINEL|deadbeef/);
});

test("9c: output stays bounded and counts are not shed", () => {
  const many = [rcpt(1, DEPLOY_OK), ...Array.from({ length: 300 }, (_, i) => rcpt(10 + i, `MERGED #${1000 + i} ${(i + 16).toString(16).padStart(8, "0")} · ${"title ".repeat(30)}`))];
  const big = buildProjectState(base({ receipts: many }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= PROJECT_STATE_MAX_BYTES);
  assert.ok(big.delivery.mergesPostedAfterDeployReport.items.length <= 8 && big.receipts.length <= 4);
  assert.equal(big.delivery.mergesPostedAfterDeployReport.count, 300);
});

test("10: the response-latency line does not restate merge receipts as 'unshipped' by message order", t => {
  const { member, post, f, read } = setup(t);
  post(member.secret, "MERGED #5 53e4ecbb · a merge report");
  assert.equal(read(f.keys.owner).latency?.unshipped, undefined);
});
