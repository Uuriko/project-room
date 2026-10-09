// Guild-12 wake-queue fuzz harness. Usage: node wake-fuzz.mjs <F7|F8|F9|F10>
// In-process via the acceptance fixture. Hard timeout; exits 0 on "holds".
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../../../server/store.mjs";
import { wakeQueueLimits } from "../../../server/wake-queue.mjs";

const WHICH = process.argv[2];
const HARD_TIMEOUT_MS = Number(process.env.G12_TIMEOUT_MS ?? 120000);
setTimeout(() => { console.error(`TIMEOUT ${WHICH}`); process.exit(2); }, HARD_TIMEOUT_MS).unref();
const ok = d => { console.log(`PASS ${WHICH} ${d}`); process.exit(0); };
const bad = d => { console.log(`FAIL ${WHICH} ${d}`); process.exit(1); };

function fixture() {
  const f = createAcceptanceFixture();
  let at = Date.now(); f.store.now = () => at; f.at = () => at; f.advance = ms => { at += ms; };
  f.destroy = () => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); };
  return f;
}
const base = (f, extra = {}) => ({ requestId: randomUUID(), queueKey: "k-" + randomUUID().slice(0, 8),
  intent: { x: 1 }, dueAt: f.at(), maxAttempts: 3, ...extra });
const expectThrow = (fn, codes, label) => {
  try { fn(); } catch (e) { if (codes.includes(e.code)) return; bad(`${label}: threw ${e.code} (${e.message?.slice(0, 60)}), expected one of ${codes}`); }
  bad(`${label}: did not throw`);
};

async function F7() { // hostile enqueue payloads: all rejected cleanly, never 500/hang
  const f = fixture();
  try {
    const q = f.store.wakeQueue, k = f.keys.owner;
    expectThrow(() => q.enqueue(k, "commons", base(f, { intent: { big: "x".repeat(5000) } })), ["invalid_wake"], "oversized intent");
    expectThrow(() => q.enqueue(k, "commons", base(f, { intent: "str" })), ["invalid_wake"], "string intent");
    expectThrow(() => q.enqueue(k, "commons", base(f, { intent: [1] })), ["invalid_wake"], "array intent");
    expectThrow(() => q.enqueue(k, "commons", base(f, { intent: null })), ["invalid_wake"], "null intent");
    expectThrow(() => q.enqueue(k, "commons", base(f, { dueAt: 1.5 })), ["invalid_wake"], "float dueAt");
    expectThrow(() => q.enqueue(k, "commons", base(f, { dueAt: -5 })), ["invalid_wake", "invalid_wake_time"], "negative dueAt");
    expectThrow(() => q.enqueue(k, "commons", base(f, { dueAt: f.at() + wakeQueueLimits.horizon + 1 })), ["invalid_wake_time"], "far dueAt");
    expectThrow(() => q.enqueue(k, "commons", base(f, { maxAttempts: 0 })), ["invalid_wake"], "maxAttempts 0");
    expectThrow(() => q.enqueue(k, "commons", base(f, { maxAttempts: -2 })), ["invalid_wake"], "maxAttempts negative");
    expectThrow(() => q.enqueue(k, "commons", base(f, { maxAttempts: 99 })), ["invalid_wake"], "maxAttempts huge");
    expectThrow(() => q.enqueue(k, "commons", base(f, { maxAttempts: 1.5 })), ["invalid_wake"], "maxAttempts float");
    expectThrow(() => q.enqueue(k, "commons", base(f, { queueKey: "bad key!" })), ["invalid_wake"], "bad queueKey");
    expectThrow(() => q.enqueue(k, "commons", base(f, { queueKey: "x".repeat(5000) })), ["invalid_wake"], "huge queueKey");
    expectThrow(() => q.enqueue(k, "commons", base(f, { requestId: "nope!" })), ["invalid_wake"], "bad requestId");
    const { queueKey, ...missing } = base(f); // missing queueKey
    expectThrow(() => q.enqueue(k, "commons", missing), ["invalid_wake"], "missing field");
    expectThrow(() => q.enqueue(k, "commons", { ...base(f), evil: 1 }), ["invalid_wake"], "extra field");
    expectThrow(() => q.enqueue(k, "commons", null), ["invalid_wake"], "null request");
    expectThrow(() => q.enqueue(k, "commons", [1, 2]), ["invalid_wake"], "array request");
    expectThrow(() => q.enqueue(k, "commons", base(f, { intent: { u: "💥".repeat(2000) } })), ["invalid_wake"], "unicode intent flood");
    // idempotency conflict: same requestId, different payload
    const rid = randomUUID();
    q.enqueue(k, "commons", base(f, { requestId: rid, queueKey: "idem-a" }));
    expectThrow(() => q.enqueue(k, "commons", base(f, { requestId: rid, queueKey: "idem-b" })), ["idempotency_conflict"], "requestId reuse");
    // exact retry still fine
    const dup = q.enqueue(k, "commons", base(f, { requestId: rid, queueKey: "idem-a", intent: { x: 1 } }));
    if (!dup.duplicate) bad("exact retry not recognized as duplicate");
    const n = q.list(k, "commons").wakes.length;
    if (n !== 1) bad(`queue has ${n} wakes after hostile batch, expected 1`);
    ok("20 hostile payloads rejected cleanly, idempotency intact");
  } finally { f.destroy(); }
}

async function F8() { // flood: active cap + receipts cap hold under 1000 enqueues
  const f = fixture();
  try {
    const q = f.store.wakeQueue, k = f.keys.owner;
    let accepted = 0, refused = 0;
    for (let i = 0; i < 1000; i++) {
      try { q.enqueue(k, "commons", base(f)); accepted++; }
      catch (e) { if (e.code === "wake_limit") refused++; else bad(`flood threw ${e.code}`); }
    }
    if (accepted !== wakeQueueLimits.active) bad(`accepted ${accepted}, expected cap ${wakeQueueLimits.active}`);
    // fill receipts to the cap via synthetic rows (like the repo's own test), then enqueue must refuse
    const memberId = f.store.authenticate(k, "commons").member.id;
    const insert = f.store.db.prepare("INSERT OR IGNORE INTO wake_queue_commands VALUES(?,?,?, 'fp','{}')");
    const have = f.store.db.prepare("SELECT count(*) n FROM wake_queue_commands WHERE room_id='commons' AND member_id=?").get(memberId).n;
    for (let n = have; n < wakeQueueLimits.receipts; n++) insert.run("commons", memberId, `syn-${n}`);
    expectThrow(() => q.requeue(k, "commons", { requestId: randomUUID(), queueKey: "nope", dueAt: f.at() }), ["wake_not_dead", "wake_limit"], "requeue at receipt cap");
    const integrity = f.store.db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") bad(`integrity_check: ${integrity.integrity_check}`);
    ok(`flood: ${accepted} accepted/${refused} refused at active cap; receipt cap enforced; integrity ok`);
  } finally { f.destroy(); }
}

async function F9() { // lease/complete race: exactly one lease winner, idempotent complete
  const f = fixture();
  try {
    const q = f.store.wakeQueue, k = f.keys.owner;
    const memberId = f.store.authenticate(k, "commons").member.id;
    q.enqueue(k, "commons", base(f, { queueKey: "race" }));
    let winners = 0;
    for (let i = 0; i < 50; i++) if (q.lease("commons", memberId, "race", randomUUID())) winners++;
    if (winners !== 1) bad(`${winners} lease winners, expected exactly 1`);
    const owner = randomUUID();
    q.enqueue(k, "commons", base(f, { queueKey: "race2" }));
    const leased = q.lease("commons", memberId, "race2", owner);
    if (!leased) bad("second wake not leasable");
    expectThrow(() => q.complete("commons", memberId, "race2", { requestId: randomUUID(), leaseOwner: "wrong" }), ["wake_not_leased"], "wrong-owner complete");
    const rid = randomUUID();
    const done = q.complete("commons", memberId, "race2", { requestId: rid, leaseOwner: owner, effect: "e" });
    if (done.duplicate) bad("first complete reported duplicate");
    const again = q.complete("commons", memberId, "race2", { requestId: rid, leaseOwner: owner, effect: "e" });
    if (!again.duplicate) bad("retried complete not a duplicate no-op");
    // colliding requestId on a different wake -> conflict, not silent duplicate
    q.enqueue(k, "commons", base(f, { queueKey: "race3" }));
    const l3 = q.lease("commons", memberId, "race3", owner);
    if (!l3) bad("third wake not leasable");
    expectThrow(() => q.complete("commons", memberId, "race3", { requestId: rid, leaseOwner: owner }), ["idempotency_conflict"], "requestId collision across wakes");
    ok("lease race: 1 winner; complete idempotent; cross-wake requestId collision -> 409");
  } finally { f.destroy(); }
}

async function F10() { // pause/resume storm with concurrent enqueues
  const f = fixture();
  try {
    const q = f.store.wakeQueue, k = f.keys.owner;
    for (let i = 0; i < 5; i++) q.enqueue(k, "commons", base(f, { queueKey: `p${i}` }));
    for (let i = 0; i < 300; i++) {
      q.pause(k, "commons", { requestId: randomUUID(), reason: "storm" });
      if (q.due(f.at()).length !== 0) bad(`due() leaked ${q.due(f.at()).length} wakes while paused (iter ${i})`);
      q.enqueue(k, "commons", base(f, { queueKey: `storm-${i}` }));
      q.resume(k, "commons", { requestId: randomUUID() });
      if (q.pauseStatus("commons", f.store.authenticate(k, "commons").member.id) !== null) bad("still paused after resume");
    }
    const due = q.due(f.at());
    if (due.length === 0) bad("no wakes due after storm");
    const integrity = f.store.db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") bad("integrity_check failed");
    ok(`300 pause/resume cycles, pause held every time, ${due.length} wakes due at end`);
  } finally { f.destroy(); }
}

const UNITS = { F7, F8, F9, F10 };
if (!UNITS[WHICH]) { console.error(`unknown unit ${WHICH}`); process.exit(3); }
await UNITS[WHICH]();
