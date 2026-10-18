// ClueBot phase 1: the resident per-event invariant patrol.
//
// The patrol is read-only (it writes only patrol_* tables) and files
// findings with the room, the event sequence and the hashes — the evidence
// the batch integrity suite could not produce. The bar is symmetric: a
// clean room log produces zero findings (the false-positive rate is the
// product's credibility), and each injected fault is caught at the event
// that introduces it. The three controls mirror the read-only patrol test
// (idea-forge/cluebot-readonly-report.md): log truncation of the production
// shape, an altered message body, a forged second claim.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { patrolPending, patrolStatus } from "../server/patrol.mjs";
import { jobByName } from "../server/jobs.mjs";
import { applyOutcomes, jobHealthView, runCronJobs } from "../cloudflare/job-heartbeat.mjs";
import { claimWork, createWork, updateWork } from "../server/work-claims.mjs";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";
import { event as makeEvent, EVENT_TYPES } from "../src/events.js";

function openStore(roomId = "alpha") {
  const directory = mkdtempSync(join(tmpdir(), "project-room-patrol-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  return store;
}
const headOf = (store, roomId = "alpha") =>
  store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
function post(store, id, body, roomId = "alpha") {
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
}
// Drive a claim through the kernel exactly as the routes do: mutate the
// registry row, then receipt the change with its event.
function driveClaim(store, item, action, atMs, roomId = "alpha") {
  store.workClaims.set(roomId, item);
  emitWorkClaimEvent(store, roomId, { actorId: item.owner ?? "owner", item, action, atMs });
  return item;
}
function honestClaim(store, id, roomId = "alpha") {
  const now = Date.now();
  let item = createWork({ id, title: `Task ${id}` }, { now, agentId: "owner" });
  driveClaim(store, item, "created", now, roomId);
  item = claimWork(item, "owner", { now: now + 1 });
  driveClaim(store, item, "claimed", now + 1, roomId);
  item = updateWork(item, "owner", { state: "in_progress", now: now + 2 });
  driveClaim(store, item, "state_changed", now + 2, roomId);
  return { item, now };
}
function finishClaim(store, item, now, roomId = "alpha") {
  item = updateWork(item, "owner", { state: "delivered", now: now + 3 });
  driveClaim(store, item, "state_changed", now + 3, roomId);
  item = updateWork(item, "owner", { state: "done", now: now + 4 });
  driveClaim(store, item, "state_changed", now + 4, roomId);
  return item;
}

test("clean room: messages and a full claim lifecycle file zero findings", () => {
  const store = openStore();
  try {
    post(store, "m1", "hello world");
    post(store, "m2", "second message");
    const { item, now } = honestClaim(store, "task-1");
    finishClaim(store, item, now);
    const head = headOf(store);
    assert.equal(patrolPending(store), true, "untailed events arm the patrol job");
    const result = store.patrolTick();
    assert.equal(result.fresh, 0);
    assert.equal(result.errors, undefined);
    assert.equal(result.checked, head, "the whole log was tailed");
    assert.deepEqual(store.patrolFindings(), []);
    assert.equal(patrolStatus(store).rooms[0].sequence, head, "cursor sits at the head");
    assert.equal(patrolPending(store), false, "a caught-up room does not re-arm the job");
    const again = store.patrolTick();
    assert.equal(again.checked, 0, "a steady-state tick is a no-op");
    assert.deepEqual(store.patrolFindings(), []);
  } finally { store.close(); }
});

test("an empty store does not arm the patrol job", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-patrol-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    assert.equal(patrolPending(store), false, "no rooms means nothing to patrol, even before the first tick");
    assert.equal(jobByName("patrol").enabled({}, store), false);
  } finally { store.close(); }
});

test("control A: a truncated log files head_gap at the first missing sequence", () => {
  const store = openStore();
  try {
    for (let i = 1; i <= 6; i++) post(store, `m${i}`, `message ${i}`);
    const head = headOf(store);
    // The production shape: the room head still counts events the log no
    // longer holds (the commands referencing them are gone with the tail).
    store.db.prepare("DELETE FROM commands WHERE room_id='alpha' AND sequence>?").run(head - 2);
    store.db.prepare("DELETE FROM events WHERE room_id='alpha' AND sequence>?").run(head - 2);
    const result = store.patrolTick();
    const findings = store.patrolFindings();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].invariant, "sequence");
    assert.equal(findings[0].kind, "head_gap");
    assert.equal(findings[0].sequence, head - 1, "named at the first missing sequence");
    assert.equal(findings[0].room_id, "alpha");
    assert.match(result.scanError, /sequence invariant failed at sequence/);
    assert.ok(!result.scanError.includes("alpha"), "record ids stay off the public health surface (#3334)");
    assert.equal(result.failureDetail.subcheck, "sequence");
    assert.equal(result.failureDetail.errorClass, "integrity_mismatch");
    // Parked: the same head does not re-file or re-wake the patrol.
    assert.equal(patrolPending(store), false);
    const again = store.patrolTick();
    assert.equal(again.fresh, 0);
    assert.equal(store.patrolFindings().length, 1);
  } finally { store.close(); }
});

test("control B: an altered projection body is named at its posting event, with hashes", () => {
  const store = openStore();
  try {
    post(store, "m1", "hello world");
    post(store, "m2", "untouched");
    store.patrolTick();
    const row = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get();
    const projection = JSON.parse(row.projection);
    const target = projection.messages.find(message => message.id === "m1");
    const postingSequence = store.db.prepare(
      "SELECT sequence FROM events WHERE room_id='alpha' AND json_extract(body, '$.data.messageId')='m1'").get().sequence;
    target.body = "tampered body";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(projection));
    post(store, "m3", "fresh activity brings the tail to the head");
    const result = store.patrolTick();
    const findings = store.patrolFindings();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].invariant, "messages_parity");
    assert.equal(findings[0].kind, "record_differs");
    assert.equal(findings[0].subject_id, "m1");
    assert.equal(findings[0].sequence, postingSequence, "attributed to the event that posted the message");
    assert.ok(findings[0].detail.expectedBodySha256, "the log's hash is named");
    assert.ok(findings[0].detail.actualBodySha256, "the served hash is named");
    assert.notEqual(findings[0].detail.expectedBodySha256, findings[0].detail.actualBodySha256);
    assert.equal(result.failureDetail.subcheck, "messages_parity");
    assert.equal(result.failureDetail.recordClass, "message");
  } finally { store.close(); }
});

test("control C: a forged second claim is caught at the forged event", () => {
  const store = openStore();
  try {
    const { item } = honestClaim(store, "task-1");
    assert.equal(item.state, "in_progress");
    const base = store.patrolTick();
    assert.equal(base.fresh, 0, "the honest claim history is clean");
    // Forge: a second member takes the held claim — in the log only. The
    // registry still shows the first owner, exactly the report's control.
    const sequence = headOf(store) + 1;
    const forged = makeEvent({
      id: randomUUID(), idempotencyKey: randomUUID(), type: EVENT_TYPES.WORK_CLAIM_UPDATED,
      actorId: "bob", roomId: "alpha", at: new Date().toISOString(),
      data: { workClaim: "task-1", action: "claimed", claimState: "claimed", ownerId: "bob", leaseExpiresAt: null, title: "Task task-1", paths: [] }
    });
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("alpha", sequence, forged.id, JSON.stringify(forged));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='alpha'").run(sequence);
    const result = store.patrolTick();
    const findings = store.patrolFindings();
    const kinds = findings.map(finding => finding.kind).sort();
    assert.deepEqual(kinds, ["double_claim", "surface_differs"]);
    for (const finding of findings) {
      assert.equal(finding.invariant, "claim_legality");
      assert.equal(finding.sequence, sequence, "caught at the introducing event");
      assert.equal(finding.subject_id, "task-1");
    }
    assert.equal(result.failureDetail.subcheck, "claim_legality");
  } finally { store.close(); }
});

test("receipt leg: a done claim must keep its owner and exactly one done stamp", () => {
  const store = openStore();
  try {
    const first = honestClaim(store, "task-ownerless");
    const doneFirst = finishClaim(store, first.item, first.now);
    const second = honestClaim(store, "task-twostamps");
    const doneSecond = finishClaim(store, second.item, second.now);
    assert.equal(store.patrolTick().fresh, 0, "honest completions are clean");
    // Corrupt the registry underneath the log: one done claim loses its
    // owner (its receipt would have no creator), the other gains a second
    // state:done stamp. A ci_changed receipt re-runs the agreement legs.
    store.workClaims.set("alpha", { ...doneFirst, owner: null });
    emitWorkClaimEvent(store, "alpha", { actorId: "owner", item: { ...doneFirst, owner: null }, action: "ci_changed", atMs: Date.now(), reason: "ci_changed", ciState: "success" });
    const stamps = doneSecond.history.filter(entry => entry.action === "state:done");
    store.workClaims.set("alpha", { ...doneSecond, history: [...doneSecond.history, stamps[0]] });
    emitWorkClaimEvent(store, "alpha", { actorId: "owner", item: doneSecond, action: "ci_changed", atMs: Date.now(), reason: "ci_changed", ciState: "success" });
    const result = store.patrolTick();
    assert.ok(result.fresh >= 2);
    const bySubject = new Map(store.patrolFindings().map(finding => [`${finding.subject_id}:${finding.kind}`, finding]));
    const ownerless = bySubject.get("task-ownerless:done_without_owner");
    assert.ok(ownerless, "the ownerless done claim is named");
    assert.equal(ownerless.invariant, "receipt_linkage");
    const stamped = bySubject.get("task-twostamps:done_stamp_count");
    assert.ok(stamped, "the double-stamped done claim is named");
    assert.equal(stamped.detail.stamps, 2);
  } finally { store.close(); }
});

test("job wiring: fresh findings surface in job health as a named patrol failure", async () => {
  const store = openStore();
  try {
    for (let i = 1; i <= 4; i++) post(store, `m${i}`, `message ${i}`);
    const head = headOf(store);
    store.db.prepare("DELETE FROM commands WHERE room_id='alpha' AND sequence>?").run(head - 1);
    store.db.prepare("DELETE FROM events WHERE room_id='alpha' AND sequence>?").run(head - 1);
    const job = jobByName("patrol");
    assert.ok(job, "the patrol is a registered job");
    assert.deepEqual([...job.runtimes].sort(), ["node", "worker"], "it runs in the DO and on Node");
    const tick = async at => {
      const outcomes = await runCronJobs(
        { patrol: () => job.run(store, { deadline: Date.now() + 5000 }) },
        { now: () => at, log: () => {} }
      );
      return applyOutcomes({}, outcomes);
    };
    const records = await tick(1_000);
    const entry = jobHealthView(records, 1_000).jobs.find(candidate => candidate.name === "patrol");
    assert.equal(entry.consecutiveFailures, 1);
    assert.match(entry.lastError, /sequence invariant failed/);
    assert.ok(!entry.lastError.includes("alpha"), "the room id never reaches the public error");
    assert.equal(entry.lastErrorSubcheck, "sequence");
    assert.equal(entry.lastErrorCode, "patrol_finding");
    assert.equal(entry.lastErrorClass, "integrity_mismatch");
    // The journal names what the public surface cannot: room, event, kind.
    const journal = store.patrolFindings();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].room_id, "alpha");
    assert.equal(journal[0].kind, "head_gap");
  } finally { store.close(); }
});

test("a room whose stored state cannot be processed is parked by name and stops failing the tick", () => {
  const store = openStore("aaa-poison");
  try {
    store.initialize(initialRoom("zzz-healthy"));
    post(store, "p1", "poison room message", "aaa-poison");
    post(store, "z1", "healthy one", "zzz-healthy");
    post(store, "z2", "healthy two", "zzz-healthy");
    const poisonHead = headOf(store, "aaa-poison");
    const healthyHead = headOf(store, "zzz-healthy");
    // The poison shape: the stored projection no longer parses, so the
    // agreement leg (JSON.parse of the projection at the head) throws on
    // every attempt, deterministically, at the same cursor position.
    const goodProjection = store.db.prepare("SELECT projection FROM rooms WHERE id='aaa-poison'").get().projection;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
    assert.ok(goodProjection.length > 0);

    const first = store.patrolTick();
    assert.equal(first.errors, 1, "a fresh park surfaces once as a named failure");
    assert.equal(first.parked, 1);
    assert.match(first.scanError, /patrol could not process a room \(SyntaxError\)/);
    assert.ok(!first.scanError.includes("aaa-poison"), "the room id stays off the public health surface (#3334)");
    assert.equal(first.failureDetail.code, "patrol_error");
    assert.equal(first.failureDetail.errorClass, "SyntaxError", "the summary carries the reason class, not the payload");
    assert.equal(first.failureDetail.recordClass, "room");
    // The healthy room was fully patrolled in the same tick.
    const healthy = patrolStatus(store).rooms.find(room => room.roomId === "zzz-healthy");
    assert.equal(healthy.sequence, healthyHead, "the healthy room's cursor sits at its head");
    assert.deepEqual(store.patrolFindings(), []);
    // The park is durable bookkeeping: room, cursor, head, class, error.
    const blocks = store.patrolBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].roomId, "aaa-poison");
    assert.equal(blocks[0].headSeq, poisonHead);
    assert.equal(blocks[0].sequence, 0, "the cursor never advanced past the unprocessable state");
    assert.equal(blocks[0].errorClass, "SyntaxError");
    assert.ok(blocks[0].error.length > 0 && blocks[0].error.length <= 200);
    assert.deepEqual(patrolStatus(store).parked, [{ roomId: "aaa-poison", sequence: 0, headSeq: poisonHead, errorClass: "SyntaxError" }]);
    // A parked room does not re-arm the job.
    assert.equal(patrolPending(store), false);

    const second = store.patrolTick();
    assert.equal(second.errors, undefined, "a standing park does not re-fail the tick");
    assert.equal(second.scanError, undefined);
    assert.equal(second.parked, 1, "the standing park rides the tick summary as a count");
    assert.equal(second.checked, 0, "the parked room is not retried while its head is unchanged");
    assert.equal(store.patrolBlocks().length, 1, "the park is durable, not re-recorded");
  } finally { store.close(); }
});

test("job wiring: after the fresh park, the patrol job records success with the parked count in its summary", async () => {
  const store = openStore("aaa-poison");
  try {
    post(store, "p1", "poison room message", "aaa-poison");
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
    const job = jobByName("patrol");
    let records = {};
    const tick = async at => {
      const outcomes = await runCronJobs(
        { patrol: () => job.run(store, { deadline: Date.now() + 5000 }) },
        { now: () => at, log: () => {} }
      );
      records = applyOutcomes(records, outcomes);
      return records;
    };
    // Tick 1 fails once (the fresh park). Tick 2 must succeed: before the
    // park existed, every tick failed forever and lastSuccess never moved
    // (production: 915 consecutive failures, lastSuccess null).
    const failed = await tick(1_000);
    const failedEntry = jobHealthView(failed, 1_000).jobs.find(candidate => candidate.name === "patrol");
    assert.equal(failedEntry.consecutiveFailures, 1);
    assert.equal(failedEntry.lastSuccessAt, null);
    const settled = await tick(2_000);
    const entry = jobHealthView(settled, 2_000).jobs.find(candidate => candidate.name === "patrol");
    assert.equal(entry.consecutiveFailures, 0, "the standing park no longer fails the job");
    assert.ok(entry.lastSuccessAt, "lastSuccess advances once the poison room is parked");
    assert.equal(entry.lastSummary.parked, 1, "the parked count stays visible in the job summary");

    // Head moves on the still-corrupt room: each earns a retry, and each
    // retry re-finds the identical break. Three in a row must record
    // successes — the park is refreshed and counted, the failure counter
    // holds at 0, and lastSuccessAt keeps advancing. (Before the
    // park-refresh accounting fix, every one of these ticks failed: the
    // job's green was hostage to the unrepaired room's event rate.)
    let lastSuccessAt = entry.lastSuccessAt;
    for (const at of [3_000, 4_000, 5_000]) {
      const movedHead = headOf(store, "aaa-poison") + 1;
      const raw = makeEvent({
        id: randomUUID(), idempotencyKey: randomUUID(), type: EVENT_TYPES.MESSAGE_POSTED,
        actorId: "owner", roomId: "aaa-poison", at: new Date(at).toISOString(),
        data: { messageId: `p-move-${at}`, body: "still corrupt" }
      });
      store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("aaa-poison", movedHead, raw.id, JSON.stringify(raw));
      store.db.prepare("UPDATE rooms SET sequence=? WHERE id='aaa-poison'").run(movedHead);
      const afterMove = await tick(at);
      const moveEntry = jobHealthView(afterMove, at).jobs.find(candidate => candidate.name === "patrol");
      assert.equal(moveEntry.consecutiveFailures, 0, "a same-break park refresh does not fail the job");
      assert.equal(moveEntry.lastSummary.parked, 1, "the parked count stays in the summary");
      assert.ok(moveEntry.lastSuccessAt > lastSuccessAt, "lastSuccessAt advances on head-move ticks");
      lastSuccessAt = moveEntry.lastSuccessAt;
      assert.equal(store.patrolBlocks()[0].headSeq, movedHead, "the park record was refreshed to the new head");
    }
  } finally { store.close(); }
});

test("a parked room is retried once its head moves, and a repair unparks it", () => {
  const store = openStore("aaa-poison");
  try {
    post(store, "p1", "first message", "aaa-poison");
    const goodProjection = store.db.prepare("SELECT projection FROM rooms WHERE id='aaa-poison'").get().projection;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
    assert.equal(store.patrolTick().errors, 1);
    assert.equal(store.patrolTick().errors, undefined, "parked: standing ticks succeed");

    // Head moves (a new stored message event): one retry, which throws on
    // the same corrupt projection. The retry still happens and the park is
    // still refreshed to the new head, but the re-diagnosis is not news —
    // same cursor, same error class — so it no longer surfaces as a tick
    // failure. (This assertion deliberately amends the #3988-era one below
    // it in git history, which charged one failure per head move: under an
    // unrepaired, still-active room that held the job's failure counter
    // hostage at the room's event rate, forever.)
    const movedHead = headOf(store, "aaa-poison") + 1;
    const raw = makeEvent({
      id: randomUUID(), idempotencyKey: randomUUID(), type: EVENT_TYPES.MESSAGE_POSTED,
      actorId: "owner", roomId: "aaa-poison", at: new Date().toISOString(),
      data: { messageId: "p2", body: "second message" }
    });
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("aaa-poison", movedHead, raw.id, JSON.stringify(raw));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='aaa-poison'").run(movedHead);
    const retried = store.patrolTick();
    assert.equal(retried.errors, undefined, "the moved head earns one re-diagnosis, not one failure: the break is unchanged");
    assert.equal(retried.scanError, undefined);
    assert.equal(retried.parked, 1, "the refreshed park rides the summary as a count");
    assert.equal(store.patrolBlocks()[0].headSeq, movedHead, "the park now names the new head");
    assert.equal(store.patrolTick().errors, undefined, "and then it is parked again, not wedged");

    // Repair the stored projection in place (the head does not move: the
    // raw-inserted p2 event is dropped back out so log and projection
    // agree). An in-place repair is retried by the operator's forced
    // single-room recheck, which bypasses the park; normal ticks resume
    // once it has cleared.
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run(goodProjection);
    store.db.prepare("DELETE FROM events WHERE room_id='aaa-poison' AND sequence=?").run(movedHead);
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='aaa-poison'").run(movedHead - 1);
    const healed = store.patrolTick({ roomId: "aaa-poison" });
    assert.equal(healed.errors, undefined);
    assert.equal(healed.fresh, 0, "the repaired room patrols clean");
    assert.equal(healed.parked, undefined, "no parks remain in the summary");
    assert.deepEqual(store.patrolBlocks(), [], "a room that patrols cleanly is unparked");
    assert.equal(patrolStatus(store).rooms.find(room => room.roomId === "aaa-poison").sequence, headOf(store, "aaa-poison"));
    post(store, "p2", "second message", "aaa-poison");
    const resumed = store.patrolTick();
    assert.equal(resumed.fresh, 0);
    assert.equal(resumed.errors, undefined, "normal ticks patrol the healed room again");
  } finally { store.close(); }
});

test("a parked room whose break changes kind fails once more, with the new class", () => {
  const store = openStore("aaa-poison");
  try {
    post(store, "p1", "first message", "aaa-poison");
    // Park on a torn projection with no archive marker in it: the
    // agreement leg's JSON.parse of the projection throws SyntaxError.
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
    const first = store.patrolTick();
    assert.equal(first.errors, 1, "the fresh park surfaces once as a named failure");
    assert.equal(store.patrolBlocks()[0].errorClass, "SyntaxError");

    const moveHead = messageId => {
      const movedHead = headOf(store, "aaa-poison") + 1;
      const raw = makeEvent({
        id: randomUUID(), idempotencyKey: randomUUID(), type: EVENT_TYPES.MESSAGE_POSTED,
        actorId: "owner", roomId: "aaa-poison", at: new Date().toISOString(),
        data: { messageId, body: "moved" }
      });
      store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("aaa-poison", movedHead, raw.id, JSON.stringify(raw));
      store.db.prepare("UPDATE rooms SET sequence=? WHERE id='aaa-poison'").run(movedHead);
      return movedHead;
    };

    // Same break, moved head: the refresh is not news and does not fail.
    moveHead("p2");
    const sameBreak = store.patrolTick();
    assert.equal(sameBreak.errors, undefined, "a same-break refresh rides the count, not the failure channel");
    assert.equal(sameBreak.parked, 1);
    assert.equal(store.patrolBlocks()[0].errorClass, "SyntaxError");

    // The stored break changes kind: the torn projection now carries the
    // archive marker, so the snapshot's archive read (json_extract over
    // malformed JSON) throws a plain Error before the parse leg is ever
    // reached. Same cursor, new class — that IS news, and fails once.
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'")
      .run('{"messagesArchive":{"throughSeq":1,"count":1,"retainedIds":["p1"');
    moveHead("p3");
    const changed = store.patrolTick();
    assert.equal(changed.errors, 1, "a changed break surfaces once as a named failure");
    assert.equal(changed.failureDetail.errorClass, "Error", "the new class is the named one");
    assert.match(changed.scanError, /patrol could not process a room \(Error\)/);
    assert.equal(store.patrolBlocks()[0].errorClass, "Error", "the park record carries the new break");
    const standing = store.patrolTick();
    assert.equal(standing.errors, undefined, "and then it is parked again — exactly once");
    assert.equal(standing.parked, 1);
  } finally { store.close(); }
});

test("replacing a room's log with importEvents clears a park recorded against the old log", () => {
  const store = openStore("alpha");
  try {
    post(store, "p1", "first message");
    // Minted before any park exists, and a park row is recorded directly:
    // importEvents authenticates against the room, so this test exercises
    // the store's clear-on-import path itself rather than a poison shape
    // import could not even authenticate against.
    const owner = store.issueAccessKey("alpha", "owner");
    store.patrolTick();
    store.db.prepare(`INSERT INTO patrol_blocks (room_id, sequence, event_id, head_seq, error_class, error, blocked_at)
      VALUES ('alpha', 0, NULL, ?, 'SyntaxError', 'recorded against the old log', 1)`).run(headOf(store));
    assert.equal(store.patrolBlocks().length, 1);
    const lines = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='alpha' ORDER BY sequence").all()
      .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
    store.importEvents(owner, "alpha", lines);
    assert.deepEqual(store.patrolBlocks(), [], "the park described the replaced log and does not carry");
    const result = store.patrolTick();
    assert.equal(result.errors, undefined);
    assert.equal(result.fresh, 0, "the imported log patrols clean against its rebuilt projection");
  } finally { store.close(); }
});

test("read-only store: the patrol files nothing and never throws", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-patrol-ro-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom("alpha"));
  post(store, "m1", "hello");
  store.close();
  const readOnly = new RoomStore(filename, { readOnly: true });
  try {
    const result = readOnly.patrolTick();
    assert.equal(result.skipped, 1);
    assert.deepEqual(readOnly.patrolFindings(), []);
  } finally { readOnly.close(); }
});

test("log replacement resets the room instead of filing false findings", () => {
  const store = openStore();
  try {
    post(store, "m1", "hello world");
    post(store, "m2", "second");
    store.patrolTick();
    const head = headOf(store);
    // An import rewrites event ids under the same sequences: the cursor's
    // recorded id no longer matches, so the patrol replays from zero
    // rather than trusting shadows folded from a different log.
    const atCursor = store.db.prepare("SELECT id FROM events WHERE room_id='alpha' AND sequence=?").get(head);
    store.db.prepare("UPDATE events SET id=? WHERE room_id='alpha' AND sequence=?").run(randomUUID(), head);
    assert.notEqual(store.db.prepare("SELECT id FROM events WHERE room_id='alpha' AND sequence=?").get(head).id, atCursor.id);
    const result = store.patrolTick();
    assert.equal(result.fresh, 0);
    assert.deepEqual(store.patrolFindings(), []);
    assert.equal(patrolStatus(store).rooms[0].sequence, head, "the replay reached the head again");
  } finally { store.close(); }
});

test("a long log is tailed in bounded batches, never rescanned whole", () => {
  const store = openStore();
  try {
    const base = headOf(store);
    // 450 events the patrol does not interpret (an unknown-to-it room
    // event type): the tail mechanics, not the reducer, are under test.
    const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
    for (let i = 1; i <= 450; i++) {
      const sequence = base + i;
      insert.run("alpha", sequence, randomUUID(), JSON.stringify({
        id: randomUUID(), idempotencyKey: randomUUID(), roomId: "alpha",
        type: "room.renamed", actorId: "owner", at: new Date().toISOString(), data: { name: `room ${i}` }
      }));
    }
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='alpha'").run(base + 450);
    const first = store.patrolTick();
    assert.equal(first.checked, 200, "one tick tails one bounded batch");
    assert.equal(patrolStatus(store).rooms[0].sequence, 200);
    const second = store.patrolTick();
    assert.equal(second.checked, 200);
    const third = store.patrolTick();
    assert.equal(third.checked, 52, "the final batch drains the remainder (450 inserted + 2 bootstrap events)");
    assert.equal(patrolStatus(store).rooms[0].sequence, base + 450);
    assert.equal(third.fresh, 0);
    assert.deepEqual(store.patrolFindings(), []);
  } finally { store.close(); }
});
