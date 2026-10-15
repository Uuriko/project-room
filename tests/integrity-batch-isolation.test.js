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
  // the public detail names the sub-check without the room id.
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
