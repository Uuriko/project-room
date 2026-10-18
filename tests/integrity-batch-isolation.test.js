// Blast-radius isolation for the integrity job (the claim-prs #3464 shape,
// applied to the wedge behind the production failure streak: 76 hourly
// ticks, lastErrorCode=messages_backfill_failed, cursor frozen on the
// messages pair). Before this fix, ONE poisoned record — a room whose
// messages table drifted, a room whose event log could not replay, one
// inconsistent invitation — threw out of the deferred batch or the full
// path, the cursor/snapshot never advanced, and every later check behind
// it stopped running forever. These tests pin the new contract: the
// failure is recorded durably (step, record id, code), reported on every
// tick until repaired, the cursor keeps rotating, healthy records keep
// verifying — and the tick still FAILS. Isolation is never a silent pass.
// (The unpatched wedge itself is reproduced in
// ~/workspace/bug-hunt/n2-integrity-repro.mjs, scenarios A–C.)
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

const integrityJob = JOBS.find(job => job.name === "integrity");
const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-integrity-isolation-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { integrity: "deferred" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return store;
}

async function settle(t, rooms) {
  const store = openStore(t);
  for (const id of rooms) store.initialize(initialRoom(id));
  await tick(store); // full tick writes the snapshot
  await tick(store); // incremental tick
  return store;
}

function post(store, roomId, id, body) {
  const key = store.issueAccessKey(roomId, "owner");
  const result = store.command(key, roomId, { id, type: "message.posted", data: { body } });
  return result.event.id; // the messages table keys rows by event id
}

async function certify(store, roomId) {
  for (let i = 0; i < 40; i++) {
    await tick(store);
    const row = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    if (row?.parity_at_seq != null && row.parity_at_seq === store.room(roomId).sequence) return true;
  }
  return false;
}

const failureRows = store => store.db.prepare("SELECT step, record_id AS recordId, code, failures FROM integrity_failures ORDER BY step, record_id").all();

test("parity poison: one drifted room is isolated and reported until repaired; the healthy room stays certified", async t => {
  const store = await settle(t, ["alpha", "beta"]);
  post(store, "alpha", "m-alpha", "hello alpha");
  post(store, "beta", "m-beta", "hello beta");
  assert.ok(await certify(store, "alpha"), "alpha certifies before the poison");
  assert.ok(await certify(store, "beta"), "beta certifies before the poison");

  // Poison: alpha's messages table drifts from its projection.
  store.db.prepare("UPDATE messages SET body='tampered' WHERE room_id='alpha'").run();

  // The underlying per-room check keeps its throwing contract for direct
  // callers — the poison is real, and only the batch's blast radius changed.
  store.db.prepare("UPDATE messages_backfill_cursor SET sweep_after='beta' WHERE room_id=''").run();
  assert.throws(() => store.checkMessagesParity(), /messages parity failed for alpha/);

  // Ticks no longer throw or wedge: once the parity step first reaches
  // alpha, the failure is recorded and stays on every later result until
  // repaired, while the cursor keeps rotating.
  const steps = new Set();
  let last = null;
  for (let i = 0; i < 12 && !last?.failures.some(f => f.step === "messages_parity"); i++) {
    last = await tick(store);
    steps.add(last.deferred.next);
  }
  assert.ok(last.failures.some(f => f.step === "messages_parity" && f.recordId === "alpha"), "the parity step reaches alpha and records the failure");
  for (let i = 0; i < 6; i++) {
    last = await tick(store);
    steps.add(last.deferred.next);
    assert.ok(
      last.failures.some(f => f.step === "messages_parity" && f.recordId === "alpha"),
      "alpha's parity failure is reported on every tick until repaired"
    );
  }
  assert.ok(steps.size > 3, "the deferred cursor kept rotating past the poisoned pair");
  const failure = last.failures.find(f => f.step === "messages_parity" && f.recordId === "alpha");
  assert.match(failure.message, /messages parity failed for alpha/);
  assert.equal(failure.code, "messages_parity_failed");
  assert.notEqual(
    store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='beta'").get().parity_at_seq,
    null, "beta remains certified throughout"
  );
  assert.ok(
    failureRows(store).some(r => r.step === "messages_parity" && r.recordId === "alpha" && r.failures >= 1),
    "the failure is recorded durably"
  );

  // The job still fails the tick — isolation is not a silent pass — and
  // the public error string names the sub-check without the room id (the
  // failure detail itself names the room — see integrity-naming.test.js).
  const run = await integrityJob.run(store, { deadline: Date.now() + 5000 });
  assert.ok(Number(run.errors) >= 1);
  assert.equal(run.failureDetail.subcheck, "messages_parity");
  assert.equal(run.failureDetail.recordClass, "message");
  assert.ok(!run.scanError.includes("alpha"), "the room id never reaches the public error");

  // Repair the drift (the event log is authoritative): the record clears
  // and the job recovers.
  store.db.prepare("UPDATE messages SET body='hello alpha' WHERE room_id='alpha'").run();
  let recovered = null;
  for (let i = 0; i < 15 && !recovered; i++) {
    const result = await tick(store);
    if (!result.failures.length) recovered = result;
  }
  assert.ok(recovered, "the repaired room clears the failure");
  assert.deepEqual(failureRows(store), []);
});

test("backfill poison: a room whose log cannot replay is skipped while other rooms backfill in the same call", async t => {
  const store = await settle(t, ["alpha", "gamma"]);
  post(store, "gamma", "g1", "first");
  post(store, "gamma", "g2", "second");
  assert.ok(await certify(store, "gamma"), "gamma backfills and certifies before the poison");
  assert.ok(await certify(store, "alpha"), "alpha certifies before the poison");

  // Poison: gamma's stored sequence runs ahead of its event log, so the
  // log can never replay to the room's current sequence again.
  store.db.prepare("UPDATE rooms SET sequence = sequence + 3 WHERE id='gamma'").run();

  // Fresh work for the healthy room, posted after the poison.
  const laterId = post(store, "alpha", "a-later", "after the poison");

  // One direct backfill call: gamma is named in `failed`, and alpha's new
  // message is written in the same call.
  const result = store.backfillMessages({ limit: 400 });
  assert.deepEqual(result.failed.map(f => f.roomId), ["gamma"]);
  assert.match(String(result.failed[0].error.message), /messages backfill stopped at/);
  assert.equal(
    store.db.prepare("SELECT body FROM messages WHERE room_id='alpha' AND message_id=?").get(laterId)?.body,
    "after the poison"
  );

  // Through the job's ticks the failure is durable and reported, while
  // alpha's parity (step 10, behind backfill's step 9) still certifies.
  let last = null;
  for (let i = 0; i < 12; i++) last = await tick(store);
  assert.ok(
    last.failures.some(f => f.step === "messages_backfill" && f.recordId === "gamma"),
    "gamma's backfill failure is reported on the tick result"
  );
  assert.ok(
    failureRows(store).some(r => r.step === "messages_backfill" && r.recordId === "gamma"),
    "the failure is recorded durably"
  );
  assert.equal(
    store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='alpha'").get().parity_at_seq,
    store.room("alpha").sequence,
    "alpha still certifies at its head"
  );
});

test("backfill interruption is control flow, not a room failure: a throwing yield hook still propagates", async t => {
  const store = openStore(t);
  const roomId = "bulk";
  const events = initialRoom(roomId);
  for (let i = 0; i < 30; i += 1) {
    events.push(event({
      type: T.MESSAGE_POSTED, actorId: "owner", roomId, id: `ev-${i}`,
      idempotencyKey: `ev-${i}-key`, at: new Date(Date.UTC(2026, 9, 2) + i * 1000).toISOString(),
      data: { messageId: `m${i}`, body: `line ${i}` }
    }));
  }
  store.initialize(events);
  // The caller's stop signal must not be swallowed as a "failed room":
  // it propagates, the committed prefix stays on the cursor, and a plain
  // call afterwards finishes the room with no failure recorded.
  assert.throws(
    () => store.backfillMessages({ limit: 400, yieldBetween: () => { throw new Error("interrupted"); } }),
    /interrupted/
  );
  const cursor = store.db.prepare("SELECT applied_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
  assert.ok(cursor.applied_seq > 0 && cursor.applied_seq < store.room(roomId).sequence, "the committed prefix survives the interruption");
  const result = store.backfillMessages({ limit: 400 });
  assert.deepEqual(result.failed, []);
  assert.equal(result.done, true);
});

test("step isolation: a poisoned step does not stop the steps behind it in the rotation", async t => {
  const store = await settle(t, ["alpha"]);
  // Work for steps 9–10, which sit after the poisoned step in the rotation.
  // (Posted before the poison: a later command would re-sync the lifecycle
  // column from the projection and quietly repair the drift.)
  post(store, "alpha", "late", "posted after the poison");
  // Poison step 6 (room lifecycle): the column disagrees with the projection.
  store.db.prepare("UPDATE rooms SET archived_at='2026-10-01T00:00:00.000Z' WHERE id='alpha'").run();
  let certified = false;
  let sawLifecycle = false;
  for (let i = 0; i < 20 && !(certified && sawLifecycle); i++) {
    const result = await tick(store);
    certified = certified || store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='alpha'").get()?.parity_at_seq
      === store.room("alpha").sequence;
    sawLifecycle = sawLifecycle || result.failures.some(f => f.step === "room_lifecycle" && f.recordId === "");
  }
  assert.ok(certified, "messages backfill + parity still run behind the poisoned lifecycle step");
  assert.ok(sawLifecycle, "the lifecycle failure is reported while the later steps keep running");

  // Repair: the record clears on a later rotation and the store is clean.
  store.db.prepare("UPDATE rooms SET archived_at=NULL WHERE id='alpha'").run();
  let cleared = null;
  for (let i = 0; i < 15 && !cleared; i++) {
    const result = await tick(store);
    if (!result.failures.length) cleared = result;
  }
  assert.ok(cleared, "repairing the drift clears the recorded failure");
  assert.deepEqual(failureRows(store), []);
});

test("full path: one inconsistent invitation is isolated; the snapshot is not advanced over it", async t => {
  const store = openStore(t);
  store.initialize(initialRoom("commons"));
  const now = Date.now();
  const session = accountId => {
    const accessKey = store.issueAccountAccessKey(accountId);
    const slot = store.createAccountSessionSlot();
    return { token: slot.token, session: store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision) };
  };
  const owner = session(store.authenticate(store.issueAccessKey("commons", "owner")).account.id);
  const acceptedInvitation = suffix => {
    store.createAccount(`account-target-${suffix}`);
    const target = session(`account-target-${suffix}`);
    const raw = randomBytes(32).toString("base64url");
    store.issueInvitation(owner.token, "commons", {
      requestId: `integrity-isolation-${suffix}`, token: raw, intendedAccountId: `account-target-${suffix}`,
      intendedMemberId: `target-member-${suffix}`, displayName: `Target human ${suffix}`, role: "member",
      expiresAt: now + 3600000,
      expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision,
      expectedSessionBinding: owner.session.sessionBinding
    });
    store.acceptInvitation(target.token, raw, {
      redemptionId: crypto.randomUUID(), expectedRevision: 0, expectedSessionBinding: target.session.sessionBinding
    });
    return store.db.prepare("SELECT id FROM membership_invitations WHERE intended_account_id=?").get(`account-target-${suffix}`).id;
  };
  acceptedInvitation("a");
  const badId = acceptedInvitation("b");

  // Poison invitation b: its invitee's membership binding vanishes while
  // the account is live (the 2026-10-10 production shape).
  const binding = store.db.prepare("SELECT * FROM member_accounts WHERE account_id='account-target-b'").get();
  store.db.prepare("DELETE FROM member_accounts WHERE account_id='account-target-b'").run();

  // The first tick runs the full path. It completes — auditing invitation
  // a, running the deferred batch — instead of aborting on b.
  const result = await tick(store);
  assert.equal(result.verified, 0, "the full path does not certify over a failed record");
  assert.ok(
    result.failures.some(f => f.step === "invitation_audit" && f.recordId === badId),
    "the poisoned invitation is reported by id"
  );
  assert.ok(result.deferred, "the deferred batch still ran");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM integrity_snapshot").get().n, 0,
    "the snapshot is not advanced over an unverified record"
  );

  // Restore the binding: the next full pass verifies both invitations,
  // writes the snapshot, and clears the record.
  store.db.prepare("INSERT INTO member_accounts (room_id, member_id, account_id, origin) VALUES (?, ?, ?, ?)")
    .run(binding.room_id, binding.member_id, binding.account_id, binding.origin);
  const repaired = await tick(store);
  assert.equal(repaired.verified, 1);
  assert.deepEqual(repaired.failures, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM integrity_snapshot").get().n, 1);
});

test("step records survive incomplete verification: a stuck backfill and an empty parity sweep do not clear earlier step failures", async t => {
  const store = await settle(t, ["alpha"]);
  // Poison: alpha's stored sequence runs ahead of its event log, so the
  // backfill can never complete (done=false) and the parity sweep has no
  // caught-up room to check (checked=0).
  store.db.prepare("UPDATE rooms SET sequence = sequence + 3 WHERE id='alpha'").run();
  // Step-scoped records from an earlier wedge, one per messages step.
  store.recordIntegrityFailure("messages_backfill", "", new Error("messages backfill stopped at 1 before room alpha reached sequence 2"));
  store.recordIntegrityFailure("messages_parity", "", new Error("messages parity failed for alpha: projection count 1, table count 1, projection last seq 1, table last seq 1"));
  store.db.prepare("UPDATE integrity_job_cursor SET step=9 WHERE singleton=1").run();

  // The pair runs: the backfill names alpha per-room, the parity sweep
  // checks nothing — and NEITHER step-scoped record clears, because
  // neither step verifiably covered its scope this visit.
  let result = await tick(store);
  const stepRows = () => failureRows(store).filter(row => row.recordId === "");
  assert.ok(stepRows().some(row => row.step === "messages_backfill"), "the backfill step record survives an incomplete backfill");
  assert.ok(stepRows().some(row => row.step === "messages_parity"), "the parity step record survives a checked=0 sweep");
  assert.ok(result.failures.some(f => f.step === "messages_backfill" && f.recordId === ""), "the step record is still reported");
  assert.ok(result.failures.some(f => f.step === "messages_backfill" && f.recordId === "alpha"), "alpha's per-room failure is recorded alongside");
  for (let i = 0; i < 10; i++) result = await tick(store);
  assert.equal(stepRows().length, 2, "repeated incomplete visits never clear the step records");

  // Repair the log: the backfill now completes its whole scope and the
  // parity sweep certifies a room — explicit successful verification —
  // and only then do the step records clear.
  store.db.prepare("UPDATE rooms SET sequence = sequence - 3 WHERE id='alpha'").run();
  let clean = null;
  for (let i = 0; i < 25 && !clean; i++) {
    await tick(store);
    if (!failureRows(store).length) clean = true;
  }
  assert.ok(clean, "completed verification clears every record");
});

test("operational errors propagate: a schema failure in a deferred step throws instead of being isolated as data", async t => {
  const store = await settle(t, ["alpha"]);
  // Step 0 (share_links) loses its table: a schema failure indicts the
  // store, not a record. The batch must surface it on the job's throw
  // path — no durable record, no cursor advance past it.
  store.db.exec("DROP TABLE share_links");
  store.db.prepare("UPDATE integrity_job_cursor SET step=0 WHERE singleton=1").run();
  await assert.rejects(tick(store), /no such table: share_links/);
  assert.deepEqual(failureRows(store), [], "no failure record is written for an operational error");
  assert.equal(
    store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get().step, 0,
    "the cursor does not advance past the operational failure"
  );
});

test("operational errors in the messages backfill are not isolated as room data", async t => {
  const store = await settle(t, ["alpha"]);
  const eventId = post(store, "alpha", "held", "held back by the environment");
  const original = store.db.prepare.bind(store.db);
  const sabotage = error => {
    store.db.prepare = sql => {
      if (typeof sql === "string" && sql.includes("sequence>?")) throw error;
      return original(sql);
    };
  };
  try {
    // Lock contention (SQLITE_BUSY) is the environment failing: the
    // backfill call aborts instead of naming alpha a failed room.
    sabotage(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
    assert.throws(() => store.backfillMessages({ limit: 10 }), /database is locked/);
    // The typed storage refusal likewise: its transaction already rolled
    // back, and the room's data is not the cause.
    sabotage(Object.assign(new Error("Storage is unavailable; no success is claimed"), { code: "storage_unavailable", status: 503 }));
    assert.throws(() => store.backfillMessages({ limit: 10 }), /Storage is unavailable/);
  } finally {
    store.db.prepare = original;
  }
  // Unsabotaged, the same room backfills cleanly — it was never bad data.
  const result = store.backfillMessages({ limit: 10 });
  assert.deepEqual(result.failed, []);
  assert.equal(result.done, true);
  assert.equal(
    store.db.prepare("SELECT body FROM messages WHERE room_id='alpha' AND message_id=?").get(eventId)?.body,
    "held back by the environment"
  );
});

test("failure records persist only allowlisted diagnostics, and the job log does not re-emit stored text", async t => {
  const store = openStore(t);
  store.initialize(initialRoom("commons"));
  // A recognized verdict template survives with its counts intact.
  store.recordIntegrityFailure("messages_parity", "alpha",
    new Error("messages parity failed for alpha: projection count 7, table count 3, projection last seq 9, table last seq 4"));
  // Arbitrary exception text — a parser error quoting record content —
  // is reduced to the generic line for the step.
  store.recordIntegrityFailure("invitation_audit", "inv-1",
    new Error('Unexpected token < in JSON at position 2: {"displayName":"SYNTHETIC-SECRET-1"}'));
  const rows = store.integrityFailures();
  assert.equal(
    rows.find(row => row.step === "messages_parity")?.message,
    "messages parity failed for alpha: projection count 7, table count 3, projection last seq 9, table last seq 4"
  );
  const reduced = rows.find(row => row.step === "invitation_audit");
  assert.equal(reduced?.message, "invitation_audit integrity check failed");
  assert.ok(!JSON.stringify(rows).includes("SYNTHETIC-SECRET-1"), "no record content reaches durable storage");

  // The job's operator log line for an outstanding failure carries the
  // allowlisted fields (sub-check, record id, code, class, count) — not
  // the stored message text, however it got there.
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  let run;
  try {
    run = await integrityJob.run(store, {
      deadline: Date.now() + 5000,
      room: {
        verifyRoomIntegrity: async () => ({
          failures: [{ step: "messages_parity", recordId: "alpha", code: "messages_parity_failed", message: "blew up on SYNTHETIC-SECRET-2 payload" }]
        })
      }
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(run.errors, 1);
  assert.equal(run.failureDetail.subcheck, "messages_parity");
  const logLine = lines.find(line => line.includes("[integrity]"));
  assert.ok(logLine?.includes("alpha") && logLine.includes("messages_parity_failed"), "the log line names the record and the stable code");
  assert.ok(!lines.join("\n").includes("SYNTHETIC-SECRET-2"), "stored text is not re-emitted to the log");
  assert.ok(!JSON.stringify(run).includes("SYNTHETIC-SECRET-2"), "nor to the public result");
});

test("recheck reconciliation: a help record for a room whose help trace is gone clears while another room still has help", async t => {
  const store = await settle(t, ["alpha", "beta"]);
  // Beta still carries (phantom) help state, so the help audit runs.
  const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='beta'").get().projection);
  projection.helpOffers = { poison: true };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='beta'").run(JSON.stringify(projection));
  // Alpha's record dates from when it had help; its trace is entirely
  // gone now, so the audit can never return it in `checked` again.
  store.recordIntegrityFailure("help_history", "alpha", new Error("Help invitation history requires operator reconciliation"));

  store.recheckIntegrityFailures();
  const rows = failureRows(store).filter(row => row.step === "help_history");
  assert.ok(!rows.some(row => row.recordId === "alpha"), "the moot record is reconciled away");
  assert.ok(rows.some(row => row.recordId === "beta"), "the room the audit can still see keeps its record");
});

test("full path reconciliation: a repaired room's stale help record clears on the next full pass; certification follows the reconciled state", async t => {
  const store = await settle(t, ["alpha", "beta"]);
  const verifiedAt = () => store.db.prepare("SELECT verified_at FROM integrity_snapshot WHERE id=1").get()?.verified_at;
  const before = verifiedAt();
  const poison = roomId => {
    const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
    projection.helpOffers = { poison: true };
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  };
  const repair = roomId => {
    const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
    delete projection.helpOffers;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  };

  poison("alpha");
  let result = null;
  for (let i = 0; i < 12 && !result; i++) {
    const candidate = await tick(store);
    if (candidate.failures.some(f => f.step === "help_history" && f.recordId === "alpha")) result = candidate;
  }
  assert.ok(result, "alpha's help failure is reported");
  assert.equal(result.verified, 0);
  assert.equal(verifiedAt(), before, "the snapshot is not advanced over alpha's failure");

  // Repair alpha; poison beta instead. The audits can no longer see any
  // help trace for alpha — its record is reconciled away rather than
  // reported forever — while beta's live failure still blocks
  // certification and the snapshot.
  repair("alpha");
  poison("beta");
  result = null;
  for (let i = 0; i < 12 && !result; i++) {
    const candidate = await tick(store);
    if (candidate.failures.some(f => f.step === "help_history" && f.recordId === "beta")) result = candidate;
  }
  assert.ok(result, "beta's help failure is reported");
  assert.ok(!failureRows(store).some(row => row.step === "help_history" && row.recordId === "alpha"), "alpha's stale record is reconciled");
  assert.equal(result.verified, 0, "no certification while a live record remains outstanding");
  assert.equal(verifiedAt(), before, "the snapshot is still not advanced");

  // Repair beta and force one more full pass: nothing outstanding, so
  // the path certifies and the snapshot finally advances.
  repair("beta");
  store.db.exec("DELETE FROM integrity_snapshot");
  result = await tick(store);
  assert.equal(result.verified, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(failureRows(store), []);
  assert.ok(verifiedAt() && verifiedAt() !== before, "the snapshot advances on a clean reconciled state");
});

test("full path: a room with unreconcilable help history is isolated and reported until repaired", async t => {
  const store = await settle(t, ["alpha", "beta"]);
  const verifiedAt = () => store.db.prepare("SELECT verified_at FROM integrity_snapshot WHERE id=1").get()?.verified_at;
  const before = verifiedAt();
  // Poison: alpha's projection gains help state with no help events behind it.
  const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection);
  projection.helpOffers = { poison: true };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(projection));

  let reported = null;
  for (let i = 0; i < 10 && !reported; i++) {
    const result = await tick(store);
    if (result.failures.some(f => f.step === "help_history" && f.recordId === "alpha")) reported = result;
  }
  assert.ok(reported, "alpha's help failure is reported, not thrown");
  assert.equal(reported.verified, 0, "the full path does not certify over the failed room");
  assert.ok(reported.deferred, "the deferred batch still ran");
  assert.equal(verifiedAt(), before, "the snapshot is not advanced");

  // Repair: drop the phantom help state. The record clears (the full path
  // re-audits, or the batch's targeted recheck does) and the store is clean.
  const repairedProjection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection);
  delete repairedProjection.helpOffers;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(repairedProjection));
  let cleared = null;
  for (let i = 0; i < 15 && !cleared; i++) {
    const result = await tick(store);
    if (!result.failures.length) cleared = result;
  }
  assert.ok(cleared, "the repaired room's record clears");
  assert.deepEqual(failureRows(store), []);
});
