// CHAOS — EVENT EMISSION UNDER FAULTS (PRODUCT-200 reliability, C5).
//
// Every board/work-claim mutation must emit its event even under injected
// faults. The two mutation paths under test:
//   (a) store.command() — the room command pipeline (message.*, work.*,
//       claim.* with the board mirror in the same transaction);
//   (b) registry.set + emitWorkClaimEvent — the /work-claims REST path
//       (server/work-claim-routes.mjs commit(), one transaction).
//
// Scenarios (all deterministic; FAULT_SEED fixed, PROPERTY_TEST_SEED shifts):
//   S1 kill mid-transaction — a seeded throw before each write statement
//      inside command()'s transaction, swept over every write position:
//      assert full rollback (no mutation without its event, no phantom
//      event), then assert the store is still usable.
//   S2 fsync fault at COMMIT — COMMIT throws before landing: assert rollback.
//   S3 commit lands but reports failure — COMMIT throws after the real
//      commit: assert exactly-once (event + mutation present exactly once),
//      then the same command id retried from a SECOND connection returns
//      duplicate:true with the original sequence and appends nothing.
//   S4 true SIGKILL mid-transaction — a child process holds a write
//      transaction open on a WAL file DB and is killed before COMMIT:
//      assert journal recovery leaves no partial state and the reopened
//      store is usable.
//   S5 delay before COMMIT + concurrent writer — worker A holds COMMIT open
//      while worker B's command blocks on the write lock: assert event order
//      == commit (serialization) order, sequences stay contiguous 1..N, and
//      a concurrent reader always sees a consistent prefix (no reversal,
//      no phantom).
//   S6 board REST path — fault sweep over registry.set + emitWorkClaimEvent:
//      assert the claim row and its event are both-or-neither.
//   S7 canary — the integrity checker rejects a hand-corrupted log (phantom
//      event; sequence bump without an event), proving the checker is not
//      vacuous.
//
// Fail-first: S1/S2/S6 were run red against a deliberately broken build
// (event INSERT removed from command() / emitWorkClaimEvent) before this
// file was finalized; the break was reverted afterwards.
//
// Deliberate exceptions (documented, not silent): emitWorkClaimEvent skips
// the event (claim write still commits) when the room is archived — an
// archived room has no live timeline. The coalesce:true path also skips.
// Neither is exercised here; all scenarios use live rooms without coalescing.
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { emitWorkClaimEvent } from "../../server/work-claim-events.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KILL_WRITER = path.join(HERE, "helpers", "kill-writer.mjs");
const CONCURRENT_WRITER = path.join(HERE, "helpers", "concurrent-writer.mjs");

// Fixed default seed (repo convention, cf. tests/writer-fence-property.test.js);
// PROPERTY_TEST_SEED shifts the exploration for an extra run.
const seedOffset = Number(process.env.PROPERTY_TEST_SEED ?? 0);
function rng(seed) {
  let s = (seed + seedOffset) >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int };
}
const R = rng(0xC4A05);

// --- fault-injection harness ---------------------------------------------
// Wraps the store's DatabaseSync handle: counts write statements issued while
// armed and can throw before a chosen write, or intercept COMMIT to simulate
// an fsync fault (throw before/after the real commit) or a slow fsync.
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
function instrument(store) {
  const db = store.db;
  const state = { armed: false, writes: 0, throwAtWrite: 0, commitMode: null, delayMs: 0, onBegin: null };
  const realPrepare = db.prepare.bind(db);
  const realExec = db.exec.bind(db);
  db.prepare = function (sql, ...args) {
    const stmt = realPrepare(sql, ...args);
    if (!WRITE_RE.test(String(sql))) return stmt;
    const realRun = stmt.run.bind(stmt);
    stmt.run = function (...runArgs) {
      if (state.armed) {
        state.writes += 1;
        if (state.throwAtWrite > 0 && state.writes === state.throwAtWrite) {
          throw new Error(`chaos: injected fault before write #${state.writes}`);
        }
      }
      return realRun(...runArgs);
    };
    return stmt;
  };
  db.exec = function (sql, ...args) {
    const norm = String(sql).trim().toUpperCase();
    if (state.armed && norm === "BEGIN IMMEDIATE" && typeof state.onBegin === "function") {
      const ret = realExec(sql, ...args);
      state.onBegin();
      return ret;
    }
    if (state.armed && norm === "COMMIT" && state.commitMode) {
      if (state.commitMode === "throw-before") throw new Error("chaos: injected fsync fault at COMMIT");
      if (state.commitMode === "delay") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.delayMs);
      if (state.commitMode === "throw-after") {
        realExec(sql, ...args); // the commit lands...
        throw new Error("chaos: commit landed but reported failed"); // ...but the caller sees a failure
      }
    }
    return realExec(sql, ...args);
  };
  return {
    arm(plan) {
      Object.assign(state, { armed: true, writes: 0, throwAtWrite: 0, commitMode: null, delayMs: 0, onBegin: null }, plan);
    },
    disarm() { state.armed = false; },
    restore() { delete db.prepare; delete db.exec; },
  };
}

// --- snapshots + invariants ----------------------------------------------
// The three emission invariants, checked after every fault:
//   I1 no mutation commits without its event: rooms.sequence advances only
//      with its event rows present (sequences contiguous 1..N, N == count).
//   I2 no event without its mutation: no event row beyond rooms.sequence
//      (no phantom), and the faulted command leaves no commands-table row.
//   I3 event ordering matches commit ordering: covered by S5 (sequence
//      order == serialization order under concurrency).
function snapshot(store, roomId) {
  const roomSeq = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? null;
  const events = store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
  const claims = store.db.prepare("SELECT claim_id, item_json, updated_at FROM work_claims WHERE room_id=? ORDER BY claim_id").all(roomId);
  return { roomSeq, events, claims };
}

function assertIntegrity(store, roomId, label) {
  const { roomSeq, events } = snapshot(store, roomId);
  const over = events.filter(r => r.sequence > roomSeq);
  assert.equal(over.length, 0,
    `${label}: phantom event — ${over.length} event row(s) beyond committed rooms.sequence=${roomSeq}`);
  assert.equal(roomSeq, events.length,
    `${label}: dropped event — rooms.sequence=${roomSeq} but the log holds ${events.length} event(s)`);
  const seqs = events.map(r => r.sequence);
  assert.deepEqual(seqs, events.map((_, i) => i + 1), `${label}: event sequences are contiguous from 1 (no gap, no reorder)`);
  for (const row of events) {
    const ev = JSON.parse(row.body);
    assert.equal(ev.roomId, roomId, `${label}: event ${row.sequence} belongs to this room`);
    assert.equal(typeof ev.type, "string", `${label}: event ${row.sequence} has a type`);
  }
}

function assertRollback(store, roomId, before, cmdIdOrNull, label) {
  const after = snapshot(store, roomId);
  assert.deepEqual(after.events, before.events, `${label}: no partial event survived the fault`);
  assert.deepEqual(after.claims, before.claims, `${label}: no partial board write survived the fault`);
  assert.equal(after.roomSeq, before.roomSeq, `${label}: room sequence unchanged by the faulted mutation`);
  if (cmdIdOrNull) {
    const cmdRow = store.db.prepare("SELECT sequence AS s FROM commands WHERE room_id=? AND id=?").get(roomId, cmdIdOrNull);
    assert.equal(cmdRow ?? null, null, `${label}: the faulted command left no commands-table row`);
  }
  assertIntegrity(store, roomId, `${label} (post-rollback)`);
}

// --- fixtures --------------------------------------------------------------
function setupRoom(store, roomId) {
  store.initialize(initialRoom(roomId));
  const keys = { owner: store.issueAccessKey(roomId, "owner") };
  store.command(keys.owner, roomId, { id: `fx-${roomId}-peer`, type: "member.added",
    data: { memberId: "peer", displayName: "Peer", kind: "human", permissions: [] } });
  keys.peer = store.issueAccessKey(roomId, "peer");
  return keys;
}

let uid = 0;
const tag = prefix => `${prefix}-n${uid++}`;
const futureIso = () => new Date(Date.now() + 3600e3).toISOString();

function buildPost(t) {
  const id = `m-${t}`;
  return { cmd: { id: `c-post-${t}`, type: "message.posted", data: { messageId: id, body: `chaos ${id}` } }, actor: "owner" };
}
function buildPropose(t) {
  const id = `w-${t}`;
  return { cmd: { id: `c-prop-${t}`, type: "work.proposed",
    data: { workItemId: id, title: `Chaos ${id}`, definitionOfDone: "done", accountableMemberId: "owner", mode: "write" } },
    actor: "owner", workId: id };
}
function buildAccept(workId, t) {
  return { cmd: { id: `c-acc-${t}`, type: "work.accepted", data: { workItemId: workId } }, actor: "owner" };
}
function buildAcquire(workId, t) {
  return { cmd: { id: `c-acq-${t}`, type: "claim.acquired",
    data: { workItemId: workId, repository: "Uuriko/project-room", ref: "main", paths: [`chaos/${workId}.mjs`], expiresAt: futureIso() } },
    actor: "owner" };
}
function buildRenew(workId, t) {
  return { cmd: { id: `c-ren-${t}`, type: "claim.renewed", data: { workItemId: workId, expiresAt: new Date(Date.now() + 7200e3).toISOString() } }, actor: "owner" };
}
function buildRelease(workId, t) {
  return { cmd: { id: `c-rel-${t}`, type: "claim.released", data: { workItemId: workId } }, actor: "owner" };
}
function buildDelete(msgId, t) {
  return { cmd: { id: `c-del-${t}`, type: "message.deleted", data: { messageId: msgId, expectedMessageRevision: 0 } }, actor: "owner" };
}

// Each sweep kind: prereqs run unfaulted, then the target command is faulted
// at every write position. Fresh ids per attempt (tag) so attempts are
// independent; a fresh store per position keeps runs deterministic.
const SWEEP_KINDS = {
  "message.posted": {
    prepare: null,
    target: (ctx, t) => buildPost(t),
  },
  "message.deleted": {
    prepare: (store, keys, roomId) => {
      const { cmd } = buildPost(tag("delpre"));
      store.command(keys.owner, roomId, cmd);
      return { msgId: cmd.data.messageId };
    },
    target: (ctx, t) => buildDelete(ctx.msgId, t),
  },
  "claim.acquired": {
    prepare: (store, keys, roomId) => {
      const p = buildPropose(tag("acqpre")); store.command(keys.owner, roomId, p.cmd);
      store.command(keys.owner, roomId, buildAccept(p.workId, tag("acqpre")).cmd);
      return { workId: p.workId };
    },
    target: (ctx, t) => buildAcquire(ctx.workId, t),
  },
  "claim.renewed": {
    prepare: (store, keys, roomId) => {
      const p = buildPropose(tag("renpre")); store.command(keys.owner, roomId, p.cmd);
      store.command(keys.owner, roomId, buildAccept(p.workId, tag("renpre")).cmd);
      store.command(keys.owner, roomId, buildAcquire(p.workId, tag("renpre")).cmd);
      return { workId: p.workId };
    },
    target: (ctx, t) => buildRenew(ctx.workId, t),
  },
  "claim.released": {
    prepare: (store, keys, roomId) => {
      const p = buildPropose(tag("relpre")); store.command(keys.owner, roomId, p.cmd);
      store.command(keys.owner, roomId, buildAccept(p.workId, tag("relpre")).cmd);
      store.command(keys.owner, roomId, buildAcquire(p.workId, tag("relpre")).cmd);
      return { workId: p.workId };
    },
    target: (ctx, t) => buildRelease(ctx.workId, t),
  },
};
const MAX_WRITE_POSITIONS = 48;

// --- S1: kill mid-transaction --------------------------------------------
// Throw before each write statement inside command()'s transaction, swept
// over every write position (k=1..K; the first k that commits cleanly ends
// the sweep). After each fault: full rollback (I1/I2) and the store stays
// usable — the next command commits exactly one event at before+1.
function sweepKind(kindName, kind) {
  test(`S1 kill mid-transaction: fault sweep over write positions (${kindName})`, () => {
    let swept = 0;
    for (let k = 1; k <= MAX_WRITE_POSITIONS; k++) {
      const store = new RoomStore(":memory:");
      try {
        const roomId = `chaos-s1-${kindName}-${k}`.replace(/[^a-z0-9-]/gi, "-");
        const keys = setupRoom(store, roomId);
        const ctx = kind.prepare ? kind.prepare(store, keys, roomId) : {};
        const t = tag(`s1-${kindName}-k${k}`);
        const { cmd, actor } = kind.target(ctx, t);
        const before = snapshot(store, roomId);
        const inst = instrument(store);
        inst.arm({ throwAtWrite: k });
        let threw = null;
        try { store.command(keys[actor], roomId, cmd); }
        catch (error) { threw = error; }
        finally { inst.disarm(); inst.restore(); }
        if (!threw) {
          // k ran past the last write: a clean commit — integrity must hold.
          assertIntegrity(store, roomId, `S1 ${kindName} k=${k} (clean commit past the last fault position)`);
          break;
        }
        assert.match(threw.message, /chaos: injected fault/, `S1 ${kindName} k=${k}: the throw is our injected fault`);
        assertRollback(store, roomId, before, cmd.id, `S1 ${kindName} k=${k}`);
        // The store is still usable: the next command commits exactly one event.
        const probe = buildPost(tag("s1probe"));
        const res = store.command(keys.owner, roomId, probe.cmd);
        assert.equal(res.ok ?? true, true, `S1 ${kindName} k=${k}: probe command accepted after rollback`);
        assert.equal(res.sequence, before.roomSeq + 1, `S1 ${kindName} k=${k}: probe lands at before+1`);
        assertIntegrity(store, roomId, `S1 ${kindName} k=${k} (post-probe)`);
        swept = k;
      } finally {
        store.close();
      }
    }
    assert.ok(swept >= 1, `S1 ${kindName}: the sweep faulted at least one write position (swept=${swept})`);
  });
}
for (const [kindName, kind] of Object.entries(SWEEP_KINDS)) sweepKind(kindName, kind);

// --- S2: fsync fault at COMMIT --------------------------------------------
// COMMIT throws before landing: the whole mutation (event + projection +
// board mirror) must roll back; the store stays usable.
test("S2 fsync fault at COMMIT rolls back the whole mutation", () => {
  const store = new RoomStore(":memory:");
  try {
    const roomId = "chaos-s2-commit";
    const keys = setupRoom(store, roomId);
    // Use the two-event board-mirror command: the most writes to roll back.
    const p = buildPropose(tag("s2")); store.command(keys.owner, roomId, p.cmd);
    store.command(keys.owner, roomId, buildAccept(p.workId, tag("s2")).cmd);
    const { cmd, actor } = buildAcquire(p.workId, tag("s2"));
    const before = snapshot(store, roomId);
    const inst = instrument(store);
    inst.arm({ commitMode: "throw-before" });
    let threw = null;
    try { store.command(keys[actor], roomId, cmd); }
    catch (error) { threw = error; }
    finally { inst.disarm(); inst.restore(); }
    assert.match(threw?.message ?? "", /chaos: injected fsync fault/, "S2: the COMMIT fault surfaced");
    assertRollback(store, roomId, before, cmd.id, "S2");
    // Retry cleanly with a fresh id: commits exactly its two events.
    const retry = buildAcquire(p.workId, tag("s2retry"));
    const res = store.command(keys.owner, roomId, retry.cmd);
    // command()'s result.sequence is the PRIMARY event's sequence; the board
    // mirror's derived event lands one after it.
    assert.equal(res.sequence, before.roomSeq + 1, "S2: retried acquire's primary event lands at before+1");
    assert.equal(snapshot(store, roomId).roomSeq, before.roomSeq + 2, "S2: both events (primary + board mirror) committed");
    assertIntegrity(store, roomId, "S2 (post-retry)");
  } finally {
    store.close();
  }
});

// --- S3: commit lands but reports failure ----------------------------------
// The worst fsync lie: the commit is durable, but the caller sees an error.
// Exactly-once must hold: the event + mutation are present exactly once, and
// the same command id retried — from a SECOND connection, as a crashed
// client would — returns duplicate:true with the original sequence and
// appends nothing.
function scratchFile(name) {
  const dir = process.env.TMPDIR || os.tmpdir();
  return path.join(dir, `chaos-s3-${process.pid}-${name}.sqlite`);
}
test("S3 commit lands but reports failure: exactly-once + cross-connection idempotent retry", () => {
  const dbPath = scratchFile("commit");
  const store = new RoomStore(dbPath);
  const roomId = "chaos-s3-commit";
  const keys = setupRoom(store, roomId);
  const { cmd, actor } = buildPost(tag("s3"));
  const before = snapshot(store, roomId);
  const inst = instrument(store);
  inst.arm({ commitMode: "throw-after" });
  let threw = null;
  try { store.command(keys[actor], roomId, cmd); }
  catch (error) { threw = error; }
  finally { inst.disarm(); inst.restore(); }
  assert.match(threw?.message ?? "", /chaos: commit landed but reported failed/, "S3: the caller saw the commit failure");
  // The commit IS durable: exactly one event, one commands row, sequence +1.
  const cmdRow = store.db.prepare("SELECT sequence AS s FROM commands WHERE room_id=? AND id=?").get(roomId, cmd.id);
  assert.ok(cmdRow, "S3: the commands-table row survived the reported failure");
  const afterThrow = snapshot(store, roomId);
  assert.equal(afterThrow.events.length, before.events.length + 1, "S3: exactly one event landed");
  assert.equal(afterThrow.roomSeq, before.roomSeq + 1, "S3: sequence advanced exactly once");
  store.close();
  // A crashed client retries the same command id on a fresh connection.
  const store2 = new RoomStore(dbPath);
  try {
    const retry = store2.command(keys[actor], roomId, cmd);
    assert.equal(retry.duplicate, true, "S3: retry of the same command id is a duplicate, not a second event");
    assert.equal(retry.sequence, cmdRow.s, "S3: retry returns the original sequence");
    const afterRetry = snapshot(store2, roomId);
    assert.deepEqual(afterRetry.events.map(r => r.id), afterThrow.events.map(r => r.id), "S3: the retry appended no new event");
    assertIntegrity(store2, roomId, "S3 (post-retry)");
  } finally {
    store2.close();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch { /* best effort */ } }
  }
});

test("S3b commit fault before landing: retry from a second connection commits fresh", () => {
  const dbPath = scratchFile("commitb");
  const store = new RoomStore(dbPath);
  const roomId = "chaos-s3b-commit";
  const keys = setupRoom(store, roomId);
  const { cmd, actor } = buildPost(tag("s3b"));
  const before = snapshot(store, roomId);
  const inst = instrument(store);
  inst.arm({ commitMode: "throw-before" });
  let threw = null;
  try { store.command(keys[actor], roomId, cmd); }
  catch (error) { threw = error; }
  finally { inst.disarm(); inst.restore(); }
  assert.match(threw?.message ?? "", /chaos: injected fsync fault/, "S3b: the COMMIT fault surfaced");
  assertRollback(store, roomId, before, cmd.id, "S3b");
  store.close();
  // Nothing landed, so the same id retried on a fresh connection is a clean commit.
  const store2 = new RoomStore(dbPath);
  try {
    const retry = store2.command(keys[actor], roomId, cmd);
    assert.equal(retry.duplicate ?? false, false, "S3b: nothing committed, so the retry is fresh");
    assert.equal(retry.sequence, before.roomSeq + 1, "S3b: retry lands at before+1");
    assertIntegrity(store2, roomId, "S3b (post-retry)");
  } finally {
    store2.close();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch { /* best effort */ } }
  }
});

// --- S4: true SIGKILL mid-transaction --------------------------------------
// A child process opens the WAL file DB, begins store.command(), and is
// SIGKILLed while its write transaction is still uncommitted (the marker
// file proves the kill landed after BEGIN IMMEDIATE). On reopen, journal
// recovery must leave no partial state and the store must be usable.
function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filePath)) return resolve(true);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${filePath}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}
test("S4 SIGKILL mid-transaction (child process, WAL file): journal recovery leaves no partial state", async () => {
  const dir = process.env.TMPDIR || os.tmpdir();
  const dbPath = path.join(dir, `chaos-s4-${process.pid}.sqlite`);
  const marker = path.join(dir, `chaos-s4-${process.pid}.marker`);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, marker]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  const setup = new RoomStore(dbPath);
  const roomId = "chaos-s4-kill";
  const keys = setupRoom(setup, roomId);
  const { cmd, actor } = buildPost(tag("s4"));
  const before = snapshot(setup, roomId);
  setup.close(); // child takes the only handle from here
  const child = fork(KILL_WRITER, [dbPath, roomId, keys[actor], JSON.stringify(cmd), marker], { stdio: "ignore" });
  try {
    await waitForFile(marker, 15000);
    child.kill("SIGKILL");
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `S4: the child died by SIGKILL (got code=${code} signal=${signal})`);
    // Reopen: recovery must show the pre-kill state, nothing partial.
    const reopened = new RoomStore(dbPath);
    try {
      assertRollback(reopened, roomId, before, cmd.id, "S4");
      const probe = buildPost(tag("s4probe"));
      const res = reopened.command(keys.owner, roomId, probe.cmd);
      assert.equal(res.sequence, before.roomSeq + 1, "S4: the reopened store commits cleanly after journal recovery");
      assertIntegrity(reopened, roomId, "S4 (post-recovery)");
    } finally {
      reopened.close();
    }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, marker]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  }
});

// --- S5: delayed commit + concurrent writer --------------------------------
// Worker A holds COMMIT open 400ms (slow fsync). Worker B's command blocks
// on the write lock, then commits. Event order must equal commit
// (serialization) order, sequences stay contiguous, and a concurrent reader
// always observes a consistent prefix — never a reversal or a phantom.
function waitForWorkerMessage(worker, wantType, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off("message", onMessage); reject(new Error(`timed out waiting for worker ${wantType}`)); }, timeoutMs);
    const onMessage = msg => {
      if (msg?.type === wantType) { clearTimeout(timer); worker.off("message", onMessage); resolve(msg); }
    };
    worker.on("message", onMessage);
  });
}
test("S5 delayed commit + concurrent writer: event order matches commit order", async () => {
  const dir = process.env.TMPDIR || os.tmpdir();
  const dbPath = path.join(dir, `chaos-s5-${process.pid}.sqlite`);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  const setup = new RoomStore(dbPath);
  const roomId = "chaos-s5-concurrent";
  const keys = setupRoom(setup, roomId);
  const cmdA = buildPost(tag("s5a")).cmd; // owner, delayed commit
  const cmdB = buildPost(tag("s5b")).cmd; // peer, blocks on the lock
  const delayMs = 300 + R.int(0, 200); // seeded slow fsync
  setup.close();
  // A concurrent reader samples (sequence, events) while the writers race.
  const reader = new RoomStore(dbPath);
  const samples = [];
  const readPrefix = () => {
    const roomSeq = reader.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
    const seqs = reader.db.prepare("SELECT sequence FROM events WHERE room_id=? ORDER BY sequence").all(roomId).map(r => r.sequence);
    return { roomSeq, seqs };
  };
  const sampler = setInterval(() => samples.push(readPrefix()), 10);
  const workerA = new Worker(CONCURRENT_WRITER, { workerData: { dbPath, roomId, token: keys.owner, cmd: cmdA, delayMs } });
  let workerB = null;
  try {
    await waitForWorkerMessage(workerA, "begun");
    workerB = new Worker(CONCURRENT_WRITER, { workerData: { dbPath, roomId, token: keys.peer, cmd: cmdB, delayMs: 0 } });
    const [doneA, doneB] = await Promise.all([
      waitForWorkerMessage(workerA, "done", 20000),
      waitForWorkerMessage(workerB, "done", 20000),
    ]);
    assert.equal(doneA.ok, true, `S5: delayed writer committed (error: ${doneA.error})`);
    assert.equal(doneB.ok, true, `S5: concurrent writer committed (error: ${doneB.error})`);
    // Commit order is serialization order: A held the lock first, so A < B.
    assert.ok(doneA.sequence < doneB.sequence, `S5: delayed writer's event precedes the blocked writer's (A=${doneA.sequence} B=${doneB.sequence})`);
  } finally {
    clearInterval(sampler);
    try { await workerA.terminate(); } catch { /* already exited */ }
    if (workerB) { try { await workerB.terminate(); } catch { /* already exited */ } }
  }
  // The reader never saw a reversal or phantom: every sample is a prefix.
  assert.ok(samples.length > 0, "S5: the reader sampled during the race");
  for (const [i, s] of samples.entries()) {
    assert.deepEqual(s.seqs, s.seqs.map((_, j) => j + 1), `S5: sample ${i} is contiguous from 1`);
    assert.ok(Math.abs(s.roomSeq - s.seqs.length) <= 1,
      `S5: sample ${i} is a consistent prefix (roomSeq=${s.roomSeq} events=${s.seqs.length})`);
  }
  reader.close();
  // Final: exactly the two new events, contiguous, in commit order.
  const fin = new RoomStore(dbPath);
  try {
    assertIntegrity(fin, roomId, "S5 (final)");
    const rows = fin.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
    const byId = new Map(rows.map(r => [JSON.parse(r.body).data.messageId, r.sequence]));
    assert.ok(byId.get(cmdA.data.messageId) < byId.get(cmdB.data.messageId), "S5: log order follows commit order, not issue order");
  } finally {
    fin.close();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  }
});

// --- S6: board REST path ----------------------------------------------------
// The /work-claims commit(): registry.set + emitWorkClaimEvent in one
// transaction. Fault sweep: the claim row and its event are both-or-neither.
test("S6 board REST path (registry.set + emitWorkClaimEvent): fault sweep is both-or-neither", () => {
  const boardItem = () => ({ id: `board-s6-${tag("item")}`, title: "Direct board chaos", state: "claimed",
    owner: "owner", files: [], leaseExpiresAt: null });
  let swept = 0;
  for (let k = 1; k <= MAX_WRITE_POSITIONS; k++) {
    const store = new RoomStore(":memory:");
    try {
      const roomId = "chaos-s6-board";
      setupRoom(store, roomId);
      const item = boardItem();
      const before = snapshot(store, roomId);
      const inst = instrument(store);
      inst.arm({ throwAtWrite: k });
      let threw = null;
      try {
        store.workClaims.transaction(() => {
          store.workClaims.set(roomId, item);
          emitWorkClaimEvent(store, roomId, { actorId: "owner", item, action: "claimed" });
        });
      } catch (error) { threw = error; }
      finally { inst.disarm(); inst.restore(); }
      if (!threw) {
        assertIntegrity(store, roomId, `S6 k=${k} (clean commit past the last fault position)`);
        const saved = store.workClaims.get(roomId, item.id);
        assert.equal(saved?.state, "claimed", `S6 k=${k}: the board row committed with its event`);
        break;
      }
      assert.match(threw.message, /chaos: injected fault/, `S6 k=${k}: the throw is our injected fault`);
      assertRollback(store, roomId, before, null, `S6 k=${k}`);
      // Still usable: a later board write commits with its event.
      const item2 = boardItem();
      store.workClaims.transaction(() => {
        store.workClaims.set(roomId, item2);
        emitWorkClaimEvent(store, roomId, { actorId: "owner", item: item2, action: "claimed" });
      });
      assert.equal(store.workClaims.get(roomId, item2.id)?.state, "claimed", `S6 k=${k}: board usable after rollback`);
      assertIntegrity(store, roomId, `S6 k=${k} (post-probe)`);
      swept = k;
    } finally {
      store.close();
    }
  }
  assert.ok(swept >= 1, `S6: the sweep faulted at least one write position (swept=${swept})`);
});

// --- S7: canary — the checker is not vacuous --------------------------------
test("S7 canary: integrity checker rejects a phantom event and a dropped event", () => {
  const store = new RoomStore(":memory:");
  try {
    const roomId = "chaos-s7-canary";
    const keys = setupRoom(store, roomId);
    const { cmd } = buildPost(tag("s7"));
    store.command(keys.owner, roomId, cmd);
    const base = snapshot(store, roomId);
    // Phantom: an event row with no committed mutation behind it.
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, base.roomSeq + 50, "phantom-id",
      JSON.stringify({ id: "phantom-id", type: "message.posted", roomId, actorId: "owner", at: new Date().toISOString(), data: {} }));
    assert.throws(() => assertIntegrity(store, roomId, "S7 phantom"), /phantom event/,
      "S7: the checker flags an event row beyond the committed sequence");
    store.db.prepare("DELETE FROM events WHERE id=?").run("phantom-id");
    // Dropped: the sequence advanced with no event for it.
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(base.roomSeq + 1, roomId);
    assert.throws(() => assertIntegrity(store, roomId, "S7 dropped"), /dropped event/,
      "S7: the checker flags a committed sequence with no event row");
  } finally {
    store.close();
  }
});
