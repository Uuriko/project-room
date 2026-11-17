// room_response_latency used to turn receipt posts into "shipped", "pending" and
// merge→prod durations by pairing each merge post with the next good deploy post.
// Posting order carries no repository, environment or commit identity, so that
// pairing is not a delivery measurement. These tests drive real posts through the
// store (journal + typed log) and read the production latency document.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";
import { readResponseLatency, latencyLine, LATENCY_MAX_BYTES } from "../server/response-latency.mjs";

const MIN = 60_000, DAY = 24 * 60 * MIN;
const OK = sha => `PROD DEPLOY ${sha} · strict smoke success · live smoke success`;

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const post = (body, key = f.keys.producer) => { clock.advance(1000); const messageId = crypto.randomUUID();
    f.store.command(key, "commons", { id: crypto.randomUUID(), type: "message.posted", data: { messageId, body } }); return messageId; };
  return { f, clock, post, read: () => readResponseLatency(f.store, f.keys.owner, "commons") };
}
// Every property name anywhere in the document.
const keys = (value, out = new Set()) => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keys(v, out); } return out; };
const MEASUREMENT = /mergeToProd|shipped|^pending$|oldestPending/i;
const claimsDelivery = doc => [...keys(doc)].filter(k => MEASUREMENT.test(k));

test("a delayed deploy post is not a merge-to-prod latency", t => {
  const { clock, post, read } = setup(t);
  post("MERGED #1 aaaaaaaa · first"); clock.advance(3 * DAY);
  post(OK("aaaaaaaa"));
  const doc = read();
  assert.deepEqual(claimsDelivery(doc), [], "no shipped / pending / duration derived from posting order");
  assert.equal(doc.reportedDelivery.evidence, "member-reported");
  assert.equal(doc.reportedDelivery.verified, false);
});

test("a deploy report posted before the merge report does not make the merge 'pending' or 'unshipped'", t => {
  const { post, read } = setup(t);
  post(OK("aaaaaaaa")); post("MERGED #1 aaaaaaaa · merge report arrived second");
  const doc = read();
  assert.deepEqual(claimsDelivery(doc), []);
  assert.equal(doc.reportedDelivery.mergeReports, 1);
  assert.equal(doc.reportedDelivery.deployReports, 1);
});

test("repeated deploy reports are counted as reports, not as shipping twice", t => {
  const { post, read } = setup(t);
  post("MERGED #1 aaaaaaaa · x"); post(OK("aaaaaaaa")); post(OK("aaaaaaaa"));
  const doc = read();
  assert.deepEqual(claimsDelivery(doc), []);
  assert.equal(doc.reportedDelivery.deployReports, 2);
});

test("a rollback posted after a success keeps the last deploy report from reading as healthy", t => {
  const { post, read } = setup(t);
  post("MERGED #1 aaaaaaaa · x"); post(OK("aaaaaaaa")); post("PROD ROLLBACK · smoke ok");
  const doc = read();
  assert.deepEqual(claimsDelivery(doc), []);
  assert.equal(doc.reportedDelivery.lastDeployReport, "rollback");
});

test("a deploy report for another commit/repository is never paired with an unrelated merge", t => {
  const { post, read } = setup(t);
  post("MERGED #1 aaaaaaaa · project A"); post(OK("bbbbbbbb")); // another repo or environment: nothing in the text says which
  post("MERGED #2 abcdef12 · same 8-hex prefix as the next deploy"); post(OK("abcdef12"));
  const doc = read();
  assert.deepEqual(claimsDelivery(doc), []);
  assert.equal(doc.reportedDelivery.mergeReports, 2);
});

test("deleted receipt posts are not counted", t => {
  const { f, post, read } = setup(t);
  post(OK("aaaaaaaa"));
  const doomed = post("MERGED #9 deadbeef · will be deleted");
  assert.equal(read().reportedDelivery.mergeReports, 1, "fixture: counted before deletion");
  f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: "message.deleted", data: { messageId: doomed, expectedMessageRevision: 0 } });
  const doc = read();
  assert.equal(doc.reportedDelivery.mergeReports, 0);
  assert.doesNotMatch(JSON.stringify(doc), /deadbeef|will be deleted/);
});

test("no qualifying evidence: no section, and only merge reports means a null, not zero, after-deploy count", t => {
  const { post, read } = setup(t);
  assert.equal(read().reportedDelivery, undefined);
  assert.equal(read().ship, undefined);
  post("MERGED #1 aaaaaaaa · x");
  const doc = read();
  assert.equal(doc.reportedDelivery.mergeReportsAfterGoodDeployReport, null);
  assert.equal(doc.reportedDelivery.oldestMergeReportAfterGoodDeployMin ?? null, null);
  assert.equal(doc.reportedDelivery.lastDeployReport, "none");
});

test("the project-state latency line carries no shipping claim and the document stays bounded", t => {
  const { post, read } = setup(t);
  post("MERGED #1 aaaaaaaa · x");
  const doc = read();
  assert.deepEqual([...keys(latencyLine(doc))].filter(k => /ship/i.test(k)), []);
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= LATENCY_MAX_BYTES);
  assert.equal(doc.contractVersion, 2);
});
