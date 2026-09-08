import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { v12HelpBaseline, frozenRecoveryFixture } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { workHelpContext } from "../src/work-help.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
function setup(t) {
  const f = createAcceptanceFixture(), filename = join(f.directory, "room.sqlite"), now = Date.now();
  f.store.now = () => now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.producer, "commons", { id: "accept", type: "work.accepted", data: { workItemId: "test-handoff", expectedRevision: 0 } });
  const command = (data = {}, id = crypto.randomUUID()) => ({ id, type: "work.help_updated", data: {
    workItemId: "test-handoff", expectedRevision: f.store.room("commons").state.workItems["test-handoff"].revision,
    expectedHelpRevision: f.store.room("commons").state.workItems["test-handoff"].helpWanted?.revision ?? 0,
    status: "open", scope: "Suggest two agenda items. 🪷", expiresAt: new Date(now + 3600000).toISOString(), ...data } });
  const withdraw = () => { const c = command({ status: "withdrawn" }); delete c.data.scope; delete c.data.expiresAt; return c; };
  return { ...f, filename, now: () => now, command, withdraw, send: (c = command(), actor = "producer") => f.store.command(f.keys[actor], "commons", c) };
}

test("help commands preserve exact receipts, work revisions and read markers through restart", t => {
  const f = setup(t), before = f.store.room("commons").state, open = f.command(), first = f.send(open);
  const saved = f.store.room("commons").state, work = saved.workItems["test-handoff"];
  assert.equal(work.helpWanted.scope, open.data.scope); assert.equal(work.helpWanted.eventId, first.event.id);
  assert.equal(first.event.actorId, "producer"); assert.equal(first.event.at, new Date(f.now()).toISOString());
  assert.equal(work.revision, before.workItems["test-handoff"].revision);
  assert.deepEqual(saved.messages, before.messages); assert.deepEqual(saved.members, before.members);
  assert.throws(() => f.send({ ...open, data: { ...open.data, scope: "Changed retry" } }), { code: "idempotency_conflict" });
  const withdrawal = f.withdraw(), closed = f.send(withdrawal, "owner"), after = auditRecovery(f.store);
  const current = new RoomStore(f.filename, { now: f.now });
  try {
    assert.equal(current.command(f.keys.producer, "commons", open).event.id, first.event.id);
    assert.equal(current.command(f.keys.owner, "commons", withdrawal).event.id, closed.event.id);
    assert.equal(current.room("commons").state.workItems["test-handoff"].helpWanted.status, "withdrawn");
    assert.deepEqual(auditRecovery(current), after);
    assert.equal(current.snapshot(f.keys.producer, "commons").cursor, 0);
    assert.equal(current.snapshot(f.keys.owner, "commons").cursor, 0);
  } finally { current.close(); }
});

test("HTTP uses the authenticated actor, strict fields and existing failure semantics", async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`;
  const post = (command, actor = "producer") => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.keys[actor]}` }, body: JSON.stringify(command) });
  const before = auditRecovery(f.store).dataSha256;
  assert.equal((await post(f.command(), "reviewer")).status, 422);
  assert.equal((await post(f.command({ actorId: "owner" }))).status, 422);
  assert.equal((await post(f.command({ expectedHelpRevision: 0.5 }))).status, 422);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const command = f.command(), response = await post(command); assert.equal(response.status, 201);
  const receipt = await response.json(); assert.equal(receipt.event.actorId, "producer");
  assert.equal((await post(command)).status, 200);
  assert.equal((await post(f.command({ expectedHelpRevision: 0 }))).status, 409);
});

test("two independent database writers race update against withdrawal without losing either receipt boundary", { timeout: 15000 }, async t => {
  const f = setup(t); f.send();
  const barrier = new SharedArrayBuffer(4), jobs = [[f.command({ scope: "Updated scope" }), "producer"], [f.withdraw(), "owner"]];
  const workers = jobs.map(([command, actor]) => new Worker(`const { parentPort, workerData: d } = require('node:worker_threads');
    import(d.module).then(({RoomStore}) => { const store = new RoomStore(d.filename, {now: () => d.now});
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),0,0);
      try { parentPort.postMessage({result:store.command(d.token,'commons',d.command)}); }
      catch(e) { parentPort.postMessage({error:{status:e.status,code:e.code,message:e.message}}); }
      finally { store.close(); }
    });`, { eval: true, workerData: { module: new URL("../server/store.mjs", import.meta.url).href,
    filename: f.filename, now: f.now(), token: f.keys[actor], command, barrier } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const finished = workers.map(worker => new Promise((resolve, reject) => { worker.on("message", value => { if (!value.ready) resolve(value); }); worker.once("error", reject); }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.on("message", value => { if (value.ready) resolve(); }); worker.once("error", reject); })));
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const results = await Promise.all(finished), winner = results.findIndex(result => result.result);
  assert.equal(results.filter(result => result.result).length, 1);
  assert.equal(results[1 - winner].error.status, 409); assert.match(results[1 - winner].error.message, /Stale help invitation/);
  const [wonCommand, wonActor] = jobs[winner], after = auditRecovery(f.store);
  assert.equal(f.send(wonCommand, wonActor).event.id, results[winner].result.event.id);
  assert.deepEqual(auditRecovery(f.store), after);
  assert.equal(f.store.room("commons").state.workItems["test-handoff"].helpWanted.revision, 2);
});

for (const corruption of ["help", "basis", "definition", "access", "event-author", "event-revision", "missing-history"]) test(`help audit rejects ${corruption} hidden behind a checkpoint`, t => {
  const f = setup(t); f.send();
  const room = f.store.room("commons"), state = room.state;
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(state));
  auditRecovery(f.store);
  if (["help", "basis", "definition", "access"].includes(corruption)) {
    if (corruption === "help") state.workItems["test-handoff"].helpWanted.scope = "Forged scope";
    if (corruption === "basis") state.workItems["test-handoff"].revision++;
    if (corruption === "definition") state.workItems["test-handoff"].title = "Changed task";
    if (corruption === "access") state.members.producer.permissions = [];
    f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
    f.store.db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id='commons'").run(JSON.stringify(state));
  } else {
    const row = f.store.db.prepare("SELECT sequence,body FROM events WHERE json_extract(body,'$.type')='work.help_updated'").get(), e = JSON.parse(row.body);
    if (corruption === "event-author") e.actorId = "reviewer";
    if (corruption === "event-revision") e.data.expectedHelpRevision = 8;
    if (corruption === "missing-history") { e.type = "message.posted"; e.data = { body: "Ordinary text" }; }
    f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(e), row.sequence);
  }
  assert.throws(() => auditRecovery(f.store));
  assert.throws(() => new RoomStore(f.filename, { now: f.now }));
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }));
});

test("withdrawal remains possible at event and projection capacity; reopening does not", t => {
  const f = setup(t); f.send();
  const state = f.store.room("commons").state; state.messages.push({ body: "x".repeat(4 * 1024 * 1024) });
  f.store.db.prepare("UPDATE rooms SET sequence=10000,projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.throws(() => f.send(f.command({ scope: "Updated" })), { code: "pilot_limit" });
  const withdrawal = f.withdraw(); assert.equal(f.send(withdrawal, "owner").sequence, 10001);
  assert.equal(f.send(withdrawal, "owner").duplicate, true);
  assert.throws(() => f.send(), { code: "pilot_limit" });
  // Deliberately synthetic capacity state is not claimed to be a recoverable history.
});

test("help history crosses checkpoints and rework without resuming old consent", t => {
  const f = setup(t); f.send();
  const room = f.store.room("commons");
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(room.state));
  const sendWork = (type, data = {}, actor = "producer") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type,
    data: { workItemId: "test-handoff", expectedRevision: f.store.room("commons").state.workItems["test-handoff"].revision, ...data } });
  const done = { summary: "Agenda", evidenceUrl: "https://example.test/result", evidenceVersion: "v1", nextAction: "Review", producerId: "producer" };
  sendWork("work.completed", done); const oldCompletion = f.store.room("commons").state.workItems["test-handoff"].receipt.eventId;
  sendWork("work.blocked", { reason: "Revise", nextAction: "Discuss" });
  assert.equal(workHelpContext(f.store.room("commons").state, "test-handoff", "guest", new Date(f.now()).toISOString()).status, "consent_changed");
  f.send(); sendWork("work.blocker_resolved", { resolution: "Clear plan" });
  sendWork("work.completed", { ...done, evidenceVersion: "v2" }); sendWork("work.blocked", { reason: "Polish", nextAction: "Ask" }); f.send();
  sendWork("verification.recorded", { result: "fail", completionEventId: oldCompletion, evidenceVersion: "v1", summary: "Historical finding" }, "reviewer");
  const before = auditRecovery(f.store);
  const readOnly = new RoomStore(f.filename, { readOnly: true });
  try {
    assert.equal(workHelpContext(readOnly.room("commons").state, "test-handoff", "guest", new Date(f.now()).toISOString()).status, "open");
    assert.deepEqual(auditRecovery(readOnly), before);
  } finally { readOnly.close(); }
});

test("genuine schema12 upgrade preserves old help-like message text and refuses projection collisions atomically", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-help-migration-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, "v12"); createRuntimePackage({ repository, commit: v12HelpBaseline, destination: runtime });
  const createFixture = await frozenRecoveryFixture(repository, runtime, v12HelpBaseline);
  const { initialRoom } = await import(pathToFileURL(join(runtime, "server/bootstrap.mjs")));
  const { event } = await import(pathToFileURL(join(runtime, "src/events.js")));
  for (const target of ["ordinary", "projection", "checkpoint", "reserved-event"]) {
    const f = createFixture(join(directory, target + ".sqlite"));
    try {
      f.store.initialize([...initialRoom("old-text", "text-owner"), event({ type: "message.posted", roomId: "old-text", actorId: "text-owner",
        data: { body: "Help wanted, just ordinary text", helpWanted: "yes" } })]);
      const row = f.store.room("commons");
      if (target === "reserved-event") {
        const record = f.store.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' LIMIT 1").get();
        const e = JSON.parse(record.body); e.type = "work.help_updated";
        f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(e), record.sequence);
      } else if (target !== "ordinary") {
        const state = row.state;
        const item = Object.values(state.workItems)[0]; assert.ok(item);
        item.helpWanted = null;
        if (target === "checkpoint") f.store.db.prepare("UPDATE projection_checkpoints SET sequence=?,projection=? WHERE room_id='commons'").run(row.sequence, JSON.stringify(state));
        else f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
      }
      const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      if (target !== "ordinary") {
        assert.throws(() => new RoomStore(f.filename), /Legacy help invitation field/);
        assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 12);
        assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
        continue;
      }
      const current = new RoomStore(f.filename, { now: f.now });
      try {
        assert.equal(auditRecovery(current).schemaVersion, 13);
        assert.equal(current.room("old-text").state.messages[0].body, "Help wanted, just ordinary text");
        assert.equal(Object.hasOwn(current.room("old-text").state.messages[0], "helpWanted"), false);
        assert.equal(Object.hasOwn(current.room("commons").state.workItems[Object.keys(row.state.workItems)[0]], "helpWanted"), false);
        const workId = "post-migration-help";
        current.command(f.keys.owner, "commons", { id: "help-propose", type: "work.proposed", data: { workItemId: workId, title: "Ask for help", definitionOfDone: "Two ideas", accountableMemberId: "owner" } });
        current.command(f.keys.owner, "commons", { id: "help-accept", type: "work.accepted", data: { workItemId: workId, expectedRevision: 0 } });
        const c = { id: "help-open", type: "work.help_updated", data: { workItemId: workId, expectedRevision: 1, expectedHelpRevision: 0,
          status: "open", scope: "Two ideas", expiresAt: new Date(f.now() + 3600000).toISOString() } };
        current.command(f.keys.owner, "commons", c);
        assert.equal(workHelpContext(current.room("commons").state, workId, "agent", new Date(f.now()).toISOString()).canOffer, true);
        auditRecovery(current);
      } finally { current.close(); }
    } finally { f.store.close(); }
  }
});
