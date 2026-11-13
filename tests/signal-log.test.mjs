// room_signal_log: hash-chained, bounded, prunable operational signals.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import {
  appendSignal, computeSignalHash, canonicalJson, verifySignalChain, pruneSignalLog,
  SIGNAL_DETAIL_MAX_BYTES, SIGNAL_LOG_MAX_AGE_MS, SIGNAL_LOG_MAX_ROWS
} from "../server/signal-log.mjs";
import { recordWakeEvent } from "../server/wake-metrics.mjs";
import { buildWakeContext, readResponseLatency, LATENCY_MAX_BYTES } from "../server/response-latency.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const T = Date.UTC(2026, 10, 12, 12, 0, 0);
const db = () => new DatabaseSync(":memory:");
const rows = d => d.prepare("SELECT * FROM room_signal_log ORDER BY room_id, seq").all();

test("hash: fixed vector (TLV v1, domain-tagged, ts as u64 ms, sorted-key detail)", () => {
  const entry = { roomId: "r1", seq: 1, tsMs: T, type: "wake.sent", actorId: null, targetId: "agent-a", ref: "ws_1", parentSeq: null,
    detail: { z: 1, a: { y: 2, b: [3, "x"] } }, prevHash: null };
  assert.equal(canonicalJson(entry.detail), '{"a":{"b":[3,"x"],"y":2},"z":1}');
  assert.equal(computeSignalHash(entry).toString("hex"), "111d86883cbe407fa4b46a46824862bb7d43d8eb3eaa8dd6410f088a0dfe41a1");
  // Vector cross-checked against an independent Python TLV encoder. Optional fields are omitted, not zero-filled: an absent actor differs from an empty one.
  assert.notDeepEqual(computeSignalHash(entry), computeSignalHash({ ...entry, actorId: "" }));
  assert.notDeepEqual(computeSignalHash(entry), computeSignalHash({ ...entry, prevHash: Buffer.alloc(32) }));
  assert.notDeepEqual(computeSignalHash(entry), computeSignalHash({ ...entry, roomId: "r2" }), "tenant binding");
});

test("append chains per room, verifies, and detects edits, middle deletes and reorders", () => {
  const d = db();
  for (let i = 0; i < 5; i += 1) appendSignal(d, { roomId: "r1", at: T + i, type: "wake.sent", targetId: "a", ref: `s${i}`, detail: { k: "mention" } });
  appendSignal(d, { roomId: "r2", at: T, type: "wake.sent" });
  assert.deepEqual(verifySignalChain(d, "r1"), { ok: true, checked: 5, brokenAt: null, oldestSeq: 1, headSeq: 5 });
  assert.equal(verifySignalChain(d, "r2").checked, 1, "chains are per room");
  assert.equal(rows(d).find(r => r.room_id === "r1" && r.seq === 3).prev_hash.length, 32);
  d.prepare("UPDATE room_signal_log SET detail='{\"k\":\"dm\"}' WHERE room_id='r1' AND seq=3").run();
  assert.equal(verifySignalChain(d, "r1").brokenAt, 3);
  d.prepare("UPDATE room_signal_log SET detail='{\"k\":\"mention\"}' WHERE room_id='r1' AND seq=3").run();
  assert.equal(verifySignalChain(d, "r1").ok, true);
  d.prepare("DELETE FROM room_signal_log WHERE room_id='r1' AND seq=3").run();
  assert.equal(verifySignalChain(d, "r1").ok, false, "a hole in the middle is not pruning");
});

test("bounds: unknown types and bad input are refused, oversized detail is dropped, nothing throws", () => {
  const d = db();
  assert.equal(appendSignal(d, { roomId: "r", at: T, type: "wake.bogus" }), null);
  assert.equal(appendSignal(d, { roomId: "r", at: -1, type: "wake.sent" }), null);
  assert.equal(appendSignal(d, { roomId: "r", at: 1.5, type: "wake.sent" }), null);
  assert.equal(appendSignal(null, { roomId: "r", at: T, type: "wake.sent" }), null);
  assert.ok(appendSignal(d, { roomId: "r", at: T, type: "wake.sent", detail: { blob: "x".repeat(SIGNAL_DETAIL_MAX_BYTES) } }));
  assert.ok(appendSignal(d, { roomId: "r", at: T, type: "wake.sent", ref: "y".repeat(500), detail: { k: "dm" } }));
  const all = rows(d);
  assert.equal(all[0].detail, "{}", "an oversized detail is dropped whole, not cut mid-JSON");
  assert.equal(all[1].ref.length, 80);
  assert.ok(all.every(r => Buffer.byteLength(r.detail) <= SIGNAL_DETAIL_MAX_BYTES));
  assert.equal(verifySignalChain(d, "r").ok, true);
});

test("prune: row cap and age cap cut from the oldest end, the head survives, verification starts at the oldest retained row", () => {
  const d = db();
  for (let i = 1; i <= 50; i += 1) appendSignal(d, { roomId: "r", at: T + i * 1000, type: "wake.sent", ref: `s${i}` });
  assert.equal(pruneSignalLog(d, "r", T + 60_000, { maxRows: 20, maxAgeMs: 1e12 }), 30);
  let kept = rows(d);
  assert.equal(kept.length, 20); assert.equal(kept[0].seq, 31); assert.equal(kept.at(-1).seq, 50);
  assert.deepEqual(verifySignalChain(d, "r"), { ok: true, checked: 20, brokenAt: null, oldestSeq: 31, headSeq: 50 });
  // Age: everything older than the horizon goes, but never the newest row.
  assert.equal(pruneSignalLog(d, "r", T + 1e9, { maxRows: 1000, maxAgeMs: 1000 }), 19);
  kept = rows(d); assert.equal(kept.length, 1); assert.equal(kept[0].seq, 50);
  assert.equal(verifySignalChain(d, "r").ok, true);
  const next = appendSignal(d, { roomId: "r", at: T + 1e9, type: "wake.acked" });
  assert.equal(next.seq, 51, "the chain continues past the pruned prefix");
  assert.equal(verifySignalChain(d, "r").ok, true);
});

test("append prunes by itself at every hundredth row and keeps the table within the cap", () => {
  const d = db();
  for (let i = 0; i < SIGNAL_LOG_MAX_ROWS + 120; i += 1) appendSignal(d, { roomId: "r", at: T + i, type: "wake.sent" });
  const n = d.prepare("SELECT COUNT(*) AS n FROM room_signal_log").get().n;
  assert.ok(n <= SIGNAL_LOG_MAX_ROWS + 100 && n >= SIGNAL_LOG_MAX_ROWS, String(n));
  assert.equal(verifySignalChain(d, "r").ok, true);
  assert.ok(SIGNAL_LOG_MAX_AGE_MS <= 14 * 86400_000);
});

test("wake accounting appends typed events: sent, delivered (listener first claim), acked with latency, dropped; polls and coalesces stay counter-only", () => {
  const d = db();
  const rec = o => recordWakeEvent(d, { store: "signals", roomId: "r", subjectId: "agent-a", ...o });
  rec({ at: T, event: "emitted", kind: "mention", ref: "ws_1" });
  rec({ at: T + 1, event: "coalesced", kind: "mention" });
  rec({ at: T + 2, event: "delivered", door: "poll", kind: "mention", n: 3 });
  rec({ at: T + 3, event: "delivered", door: "poll", kind: "mention", ref: "ws_1", sentAt: T }); // a poll presentation repeats
  rec({ at: T + 4000, event: "delivered", door: "listener", kind: "mention", ref: "ws_1", sentAt: T });
  rec({ at: T + 5, event: "delivered", door: "listener", kind: "mention", ref: "ws_1", sentAt: T, signalLog: false }); // redelivery
  rec({ at: T + 9000, event: "acked", door: "rest", kind: "mention", ref: "ws_1", sentAt: T });
  rec({ at: T + 10, event: "failed", kind: "assignment", reason: "enqueue_error" });
  rec({ at: T + 11, store: "work", event: "emitted", kind: "work" }); // work store is counter-only in this version
  const log = rows(d);
  assert.deepEqual(log.map(r => r.type), ["wake.sent", "wake.delivered", "wake.acked", "wake.dropped"]);
  assert.deepEqual(JSON.parse(log[1].detail), { d: "listener", k: "mention", lat: 4000 });
  assert.deepEqual(JSON.parse(log[2].detail), { d: "rest", k: "mention", lat: 9000 });
  assert.deepEqual(JSON.parse(log[3].detail), { k: "assignment", why: "enqueue_error" });
  assert.equal(log[0].ref, "ws_1"); assert.equal(log[0].target_id, "agent-a");
  assert.equal(d.prepare("SELECT n FROM agent_wake_counters WHERE event='emitted' AND store='signals'").get().n, 1, "counters are unchanged");
  assert.equal(verifySignalChain(d, "r").ok, true);
});

test("buildWakeContext: counts and latency by group, cron ack is expired not answered, no targets or ids leak", () => {
  const row = (type, detail, ts = T) => ({ type, ts_ms: ts, detail: JSON.stringify(detail) });
  const ctx = buildWakeContext([
    row("wake.acked", { k: "dm", d: "rest", lat: 3000 }, T + 9), row("wake.acked", { k: "mention", d: "mcp", lat: 1000 }, T + 8),
    row("wake.acked", { k: "mention", d: "cron", lat: 86_400_000 }, T + 7), row("wake.delivered", { k: "mention", d: "listener", lat: 200 }, T + 6),
    row("wake.sent", { k: "mention" }, T + 5), row("wake.sent", { k: "assignment" }, T + 4), row("wake.dropped", { k: "assignment", why: "enqueue_error" }, T + 3)
  ]);
  assert.deepEqual(ctx.message, { sent: 1, delivered: 1, acked: 2, expired: 1, dropped: 0, deliverP50Ms: 200, ackP50Ms: 1000, ackP90Ms: 3000 });
  assert.equal(ctx.work.sent, 1); assert.equal(ctx.work.dropped, 1);
  assert.equal(ctx.rows, 7); assert.equal(ctx.complete, true); assert.equal(ctx.since, new Date(T + 3).toISOString());
  assert.ok(!JSON.stringify(ctx).includes("agent"));
  assert.equal(buildWakeContext([]), null);
});

test("latency read: wake context appears once the log has rows, stays inside the byte cap, and a read appends nothing", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const before = readResponseLatency(f.store, f.keys.producer, "commons");
  assert.equal(before.wake, undefined, "no log table yet: no wake section, no error");
  const now = f.store.now();
  for (let i = 0; i < 30; i += 1) {
    appendSignal(f.store.db, { roomId: "commons", at: now - 60_000 + i, type: "wake.sent", targetId: "agent-x", ref: `ws${i}`, detail: { k: "mention" } });
    appendSignal(f.store.db, { roomId: "commons", at: now - 30_000 + i, type: "wake.acked", targetId: "agent-x", ref: `ws${i}`, detail: { k: "mention", d: "rest", lat: 30_000 } });
  }
  const sizeBefore = f.store.db.prepare("SELECT COUNT(*) AS n FROM room_signal_log").get().n;
  const room = f.store.room("commons").sequence;
  f.store.now = () => now + 120_000; // past the memo window
  const doc = readResponseLatency(f.store, f.keys.producer, "commons");
  assert.equal(doc.wake.message.sent, 30); assert.equal(doc.wake.message.acked, 30); assert.equal(doc.wake.message.ackP50Ms, 30_000);
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= LATENCY_MAX_BYTES);
  assert.ok(!JSON.stringify(doc).includes("agent-x"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM room_signal_log").get().n, sizeBefore);
  assert.equal(f.store.room("commons").sequence, room);
});
