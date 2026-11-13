// turn.completed + advisory reply guard on wake ack, and the ship (merge -> prod smoke) context.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { WAKE_STALE_PRUNE_MS } from "../server/agent-heartbeats.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";
import { REPLY_GUARD_NOTE, REPLY_WINDOW_EVENTS } from "../server/turn-guard.mjs";
import { buildShipContext, buildWakeContext, readResponseLatency, latencyLine } from "../server/response-latency.mjs";
import { recordReceiptSignal } from "../server/receipt-signals.mjs";
import { verifySignalChain } from "../server/signal-log.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const identity = f.store.identities.create("Guarded");
  const hb = f.store.agentHeartbeats, agentId = identity.identityId;
  hb.heartbeat({ agentId, hostId: "h", mode: "wakeable", wakeUrl: "https://guard.example.test/wake" });
  f.store.db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES ('commons', ?, 'producer', ?)").run(agentId, clock.now());
  const wake = (kind, messageId, roomId = "commons") => { clock.advance(5); return hb.enqueueWake({ agentId, kind, roomId, messageId }).signal; };
  const turns = () => f.store.db.prepare("SELECT ref, detail FROM room_signal_log WHERE type='turn.completed' ORDER BY seq").all().map(r => ({ ref: r.ref, ...JSON.parse(r.detail) }));
  const say = (body, extra = {}) => { clock.advance(5); return f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body, ...extra } }); };
  return { f, clock, hb, agentId, wake, turns, say };
}

test("ack after the agent spoke: turn.completed replied, no reminder", t => {
  const { clock, hb, agentId, wake, turns, say } = setup(t);
  const s = wake("mention", "m1");
  say("on it");
  clock.advance(5);
  const result = hb.ackWakes({ agentId, signalIds: [s.signalId], door: "mcp" });
  assert.deepEqual(result.acknowledged, [s.signalId]);
  assert.equal(result.replyGuard, undefined);
  assert.deepEqual(turns(), [{ ref: s.signalId, n: 1, k: "mention", rp: 1, d: "mcp" }]);
});

test("ack of a mention with no post since: one advisory reminder that licenses silence, and a silent turn is counted", t => {
  const { f, hb, agentId, wake, turns } = setup(t);
  const s = wake("dm", "d1");
  const result = hb.ackWakes({ agentId, signalIds: [s.signalId], door: "rest" });
  assert.deepEqual(result.acknowledged, [s.signalId]);
  assert.deepEqual(result.replyGuard, { advisory: true, silent: [{ signalId: s.signalId, kind: "dm", roomId: "commons" }], note: REPLY_GUARD_NOTE });
  assert.match(REPLY_GUARD_NOTE, /silence is the right answer/);
  assert.equal(turns()[0].rp, 0);
  // Acking again settles nothing: no second reminder, no second turn row.
  const again = hb.ackWakes({ agentId, signalIds: [s.signalId], door: "rest" });
  assert.deepEqual(again.acknowledged, []);
  assert.equal(again.replyGuard, undefined);
  assert.equal(turns().length, 1);
  assert.equal(verifySignalChain(f.store.db, "commons").ok, true);
  // The latency read shows the silent turn; the state line carries it.
  f.store.now = () => Date.now() + 5 * 60_000;
  const doc = readResponseLatency(f.store, f.keys.owner, "commons");
  assert.deepEqual(doc.wake.turns, { completed: 1, silent: 1, unknown: 0 });
  assert.equal(latencyLine(doc).silentTurns, 1);
});

test("never a false silent: non-message kinds, the cron door and an unreachable window are not reminded", t => {
  const { f, clock, hb, agentId, wake, turns } = setup(t);
  const ask = wake("ask", "a1");
  assert.equal(hb.ackWakes({ agentId, signalIds: [ask.signalId], door: "rest" }).replyGuard, undefined, "asks are obligations, not guarded here");
  assert.equal(turns().at(-1).rp, -1);
  const old = wake("mention", "m-old");
  for (let i = 0; i < REPLY_WINDOW_EVENTS + 5; i += 1) { clock.advance(2500); f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body: `noise ${i}` } }); }
  clock.advance(5);
  const result = hb.ackWakes({ agentId, signalIds: [old.signalId], door: "mcp" });
  assert.equal(result.replyGuard, undefined, "the journal window does not reach back to the signal: unknown, not silent");
  assert.equal(turns().at(-1).rp, -1);
  const cron = wake("mention", "m-cron");
  const before = turns().length;
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  assert.deepEqual(hb.settleWakes({ agentId }).acknowledged, [cron.signalId]);
  assert.equal(turns().length, before, "the stale-prune door never records a turn");
});

test("ship context: merge to first good prod deploy after it, pending, oldest pending, last deploy", () => {
  const T = Date.UTC(2026, 10, 12, 12, 0, 0), MIN = 60_000;
  const r = (seq, min, parsed) => ({ seq, at: new Date(T + min * MIN).toISOString(), actorId: "m", parsed });
  const receipts = [
    r(9, 100, { kind: "merged", pr: 3, sha: "cccccccc" }),
    r(8, 50, { kind: "deploy", sha: "bbbbbbbb", smoke: "failed" }),
    r(7, 40, { kind: "merged", pr: 2, sha: "bbbbbbbb" }),
    r(6, 30, { kind: "deploy", sha: "aaaaaaaa", smoke: "ok" }),
    r(5, 10, { kind: "merged", pr: 1, sha: "aaaaaaaa" })
  ];
  const ship = buildShipContext(receipts, T + 160 * MIN);
  assert.deepEqual(ship, { merged: 3, shipped: 1, pending: 2, oldestPendingMin: 120, mergeToProdP50Ms: 20 * MIN, mergeToProdP90Ms: 20 * MIN, lastDeploy: "failed" });
  assert.equal(buildShipContext([], T), null);
  assert.equal(buildShipContext([r(1, 1, { kind: "ci", pr: 1, sha: "aaaaaaaa", verdict: "passed" })], T), null);
});

test("latency read carries ship from real receipts, and the whole document stays inside the byte cap", t => {
  const { f, clock } = setup(t);
  const at = () => new Date(clock.now()).toISOString();
  const post = (body, seq) => recordReceiptSignal(f.store.db, { roomId: "commons", at: at(), actorId: "producer", body, eventId: `e${seq}`, journalSeq: seq });
  post("MERGED #1 aaaaaaaa · first", 101); clock.advance(10 * 60_000);
  post("PROD DEPLOY aaaaaaaa · strict smoke success · live smoke success", 102); clock.advance(5 * 60_000);
  post("MERGED #2 bbbbbbbb · second", 103); clock.advance(5 * 60_000);
  const doc = readResponseLatency(f.store, f.keys.owner, "commons");
  assert.equal(doc.ship.shipped, 1); assert.equal(doc.ship.pending, 1); assert.equal(doc.ship.mergeToProdP50Ms, 10 * 60_000);
  assert.equal(doc.ship.oldestPendingMin, 5);
  assert.equal(doc.wake, undefined, "receipts alone add no wake section");
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= 6144);
  assert.equal(latencyLine(doc).unshipped, 1);
  assert.equal(buildWakeContext([{ type: "turn.completed", ts_ms: 1, detail: JSON.stringify({ rp: 1 }) }]).turns.completed, 1);
});
