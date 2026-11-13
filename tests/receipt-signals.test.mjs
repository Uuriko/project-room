// Receipts as typed signals (pr.merged, ci.settled, deploy.finished, smoke.*, rollback):
// appended from the post path, preferred by the project-state read, journal text as fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { recordReceiptSignal, readReceiptSignals } from "../server/receipt-signals.mjs";
import { parseReceipt } from "../server/receipts.mjs";
import { parseReceipt as parseFromState, readProjectState } from "../server/project-state.mjs";
import { readResponseLatency } from "../server/response-latency.mjs";
import { ensureSignalLogSchema, verifySignalChain, SIGNAL_DETAIL_MAX_BYTES } from "../server/signal-log.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const T = Date.UTC(2026, 10, 12, 12, 0, 0);
const BODIES = [
  "MERGED #6180 d80e5c14 · latency: who answers whom · by owner",
  "CI #6182 d1169e17 PASSED · 41 checks · https://example.test/run/1",
  "PROD DEPLOY d80e5c14 · strict smoke success · live smoke success",
  "PROD DEPLOY 1c2db83e · ROLL FORWARD REQUIRED · smoke failure",
  "PROD ROLLBACK · smoke ok"
];
const log = d => d.prepare("SELECT type, actor_id, ref, detail FROM room_signal_log WHERE type NOT LIKE 'wake.%' ORDER BY seq").all();

test("post path: each receipt appends its typed twin; private, plain and malformed posts append nothing", () => {
  const d = new DatabaseSync(":memory:");
  const post = (body, extra = {}) => recordReceiptSignal(d, { roomId: "r", at: new Date(T).toISOString(), actorId: "m1", body, eventId: "ev1", journalSeq: 7, ...extra });
  assert.deepEqual(BODIES.map(b => post(b)), [1, 1, 2, 2, 1]);
  assert.deepEqual(log(d).map(r => r.type), ["pr.merged", "ci.settled", "deploy.finished", "smoke.passed", "deploy.finished", "smoke.failed", "rollback"]);
  assert.equal(post("PROD DEPLOY d80e5c14 · strict smoke success · live smoke success", { toMemberId: "m2" }), 0, "private never");
  assert.equal(post("hello PROD DEPLOY d80e5c14 · x"), 0);
  assert.equal(post("PROD DEPLOY nothex · x"), 0);
  assert.equal(post("MERGED #1 abcdef12 · t", { journalSeq: undefined }), 0);
  assert.equal(post(undefined), 0);
  const merged = log(d)[0];
  assert.equal(merged.actor_id, "m1"); assert.equal(merged.ref, "ev1");
  assert.deepEqual(JSON.parse(merged.detail), { js: 7, pr: 6180, sha: "d80e5c14", t: "latency: who answers whom" });
  assert.ok(log(d).every(r => Buffer.byteLength(r.detail) <= SIGNAL_DETAIL_MAX_BYTES));
  const long = post(`MERGED #2 abcdef12 · ${"x".repeat(190)}`);
  assert.equal(long, 1); assert.ok(Buffer.byteLength(log(d).at(-1).detail) <= SIGNAL_DETAIL_MAX_BYTES);
  assert.equal(verifySignalChain(d, "r").ok, true);
});

test("the typed read returns what parseReceipt returns for the same posts, newest first, and honors the floor", () => {
  const d = new DatabaseSync(":memory:");
  BODIES.forEach((body, i) => recordReceiptSignal(d, { roomId: "r", at: T + i * 1000, actorId: "m1", body, eventId: `e${i}`, journalSeq: 10 + i }));
  const typed = readReceiptSignals(d, "r");
  const expected = BODIES.map(parseReceipt);
  const strip = r => JSON.parse(JSON.stringify(r));
  assert.deepEqual(typed.map(r => strip(r.parsed)).reverse(), expected.map(strip), "same parse, deploy+rollback in order");
  assert.equal(parseFromState, parseReceipt, "project-state re-exports the one parser");
  assert.deepEqual(typed.map(r => r.seq), [14, 13, 12, 11, 10]);
  assert.equal(typed[0].at, new Date(T + 4000).toISOString());
  assert.deepEqual(readReceiptSignals(d, "r", { floorSeq: 12 }).map(r => r.seq), [14, 13]);
  assert.deepEqual(readReceiptSignals(d, "other"), []);
  assert.equal(readReceiptSignals(new DatabaseSync(":memory:"), "r"), null, "no table yet: null, not an error");
});

test("receipt read walks only receipt rows: it uses the partial index, not the wake rows", () => {
  const d = new DatabaseSync(":memory:");
  ensureSignalLogSchema(d);
  const plan = d.prepare("EXPLAIN QUERY PLAN SELECT type FROM room_signal_log INDEXED BY room_signal_log_receipts WHERE room_id=? AND type NOT LIKE 'wake.%' ORDER BY seq DESC LIMIT 200").all("r");
  assert.match(plan.map(p => p.detail).join(" "), /room_signal_log_receipts/);
  for (let i = 0; i < 300; i += 1) d.prepare("INSERT INTO room_signal_log (room_id, seq, ts_ms, type, detail, hash) VALUES ('r', ?, ?, 'wake.sent', '{}', x'00')").run(i + 1, T + i);
  recordReceiptSignal(d, { roomId: "r", at: T + 999, body: BODIES[0], journalSeq: 3 });
  assert.equal(readReceiptSignals(d, "r").length, 1);
});

test("project state: typed receipts answer when the log holds a deploy anchor, and match the journal parse exactly", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (body, extra = {}) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body, ...extra } });
  assert.equal(readProjectState(f.store, f.keys.owner, "commons").receiptWindow.source, "journal", "no log yet: text parse");
  send("MERGED #10 aaaaaaaa · first change");
  send("PROD DEPLOY aaaaaaaa · strict smoke success · live smoke success");
  send("MERGED #11 bbbbbbbb · second change");
  send("CI #11 bbbbbbbb PASSED · ok");
  send("PROD DEPLOY cccccccc · ROLL FORWARD REQUIRED · smoke failure");
  send("PROD DEPLOY dddddddd · strict smoke success · live smoke success", { toMemberId: "producer" }); // private: not a receipt
  assert.deepEqual(log(f.store.db).map(r => r.type), ["pr.merged", "deploy.finished", "smoke.passed", "pr.merged", "ci.settled", "deploy.finished", "smoke.failed"]);
  const typed = readProjectState(f.store, f.keys.owner, "commons");
  assert.equal(typed.receiptWindow.source, "log");
  f.store.db.exec("DROP INDEX room_signal_log_receipts; DROP TABLE room_signal_log");
  const text = readProjectState(f.store, f.keys.owner, "commons");
  assert.equal(text.receiptWindow.source, "journal");
  const core = s => ({ receipts: s.receipts, mergedNotDeployed: s.mergedNotDeployed, lastDeploy: s.live.lastDeploy, smoke: s.live.smoke });
  assert.deepEqual(core(typed), core(text), "the typed read and the text fallback tell the same story");
  assert.equal(typed.mergedNotDeployed.count, 1);
});

test("project state carries one latency line derived from the full latency read", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "message.posted", data: { messageId: "q", toMemberId: "producer", requestKind: "reply", body: "formal ask" } });
  const state = readProjectState(f.store, f.keys.owner, "commons");
  const full = readResponseLatency(f.store, f.keys.owner, "commons");
  assert.equal(state.latency.waiting, Object.values(full.totals).reduce((n, t) => n + t.waiting, 0), "the line is the full read's own sums");
  assert.ok(state.latency.waiting >= 1);
  assert.equal(state.latency.dropped, 0);
  assert.equal(state.latency.see, "room_response_latency");
  assert.match(state.latency.worst, /waiting/);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 6144);
});
