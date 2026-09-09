import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenAcceptanceFixture, v13OfferBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { helpOfferContext } from "../src/help-offers.js";

const workItemId = "test-handoff";
function setup(t) {
  const f = createAcceptanceFixture(), now = Date.now(); f.store.now = () => now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, c) => f.store.command(f.keys[actor], "commons", c);
  const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
  send("producer", command("work.accepted", { workItemId, expectedRevision: 0 }));
  const help = send("producer", command("work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 0,
    status: "open", scope: "Suggest two items", expiresAt: new Date(now + 3600000).toISOString() }));
  const open = (offerId = crypto.randomUUID()) => command("work.help_offer_opened", { workItemId, expectedRevision: 1,
    expectedHelpRevision: 1, helpEventId: help.event.id, offerId, plan: "I can suggest two items" });
  const update = (offerId, status = "selected") => command("work.help_offer_updated", { workItemId, expectedRevision: 1, offerId,
    expectedOfferRevision: status === "released" ? 1 : 0, status, reason: "Explicit coordination choice",
    ...(status === "selected" ? { expectedHelpRevision: 1, helpEventId: help.event.id } : {}),
    ...(status === "released" ? { externalActivityUnverified: true } : {}) });
  const add = name => {
    send("owner", command("member.added", { memberId: name, displayName: name, kind: "agent", permissions: [] }));
    f.keys[name] = f.store.issueAccessKey("commons", name);
  };
  return { ...f, filename: join(f.directory, "room.sqlite"), now, send, command, open, update, add };
}

test("authenticated offers preserve receipts, identity and immutable scope through release and restart", t => {
  const f = setup(t), before = f.store.room("commons").state;
  const open = f.open("offer"), opened = f.send("guest", open), select = f.update("offer"), selected = f.send("producer", select);
  assert.equal(opened.event.actorId, "guest"); assert.equal(selected.event.actorId, "producer");
  assert.equal(opened.event.at, new Date(f.now).toISOString());
  assert.throws(() => f.send("guest", { ...open, data: { ...open.data, plan: "Other scope" } }), { code: "idempotency_conflict" });
  const checkpoint = f.store.room("commons");
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", checkpoint.sequence, JSON.stringify(checkpoint.state));
  f.send("producer", f.command("work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 1, status: "withdrawn" }));
  assert.equal(helpOfferContext(f.store.room("commons").state, "offer", "guest", new Date(f.now).toISOString()).status, "selection_needs_review");
  const release = f.update("offer", "released"), released = f.send("guest", release);
  const after = auditRecovery(f.store), current = new RoomStore(f.filename, { now: () => f.now });
  try {
    for (const [actor, c, receipt] of [["guest", open, opened], ["producer", select, selected], ["guest", release, released]]) {
      const retry = current.command(f.keys[actor], "commons", c);
      assert.equal(retry.duplicate, true); assert.deepEqual(retry.event, receipt.event);
    }
    assert.deepEqual(auditRecovery(current), after);
    const state = current.room("commons").state;
    assert.equal(state.helpOffers.offer.status, "released"); assert.equal(state.helpOffers.offer.externalActivityUnverified, true);
    assert.equal(state.workItems[workItemId].revision, 1); assert.deepEqual(state.messages, before.messages); assert.deepEqual(state.members, before.members);
    assert.equal(current.snapshot(f.keys.guest, "commons").cursor, 0);
  } finally { current.close(); }
});

test("HTTP offer writes reject forged authority and recover a discarded response by exact retry", async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`;
  const post = (actor, c) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.keys[actor]}`, "content-type": "application/json" }, body: JSON.stringify(c) });
  const before = auditRecovery(f.store).dataSha256, forged = f.open("forged"); forged.data.actorId = "producer";
  assert.equal((await post("guest", forged)).status, 422);
  assert.equal((await post("reviewer", f.open())).status, 422);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const c = f.open("http-offer"), lost = await post("guest", c); assert.equal(lost.status, 201); await lost.arrayBuffer();
  const saved = auditRecovery(f.store), retry = await post("guest", c); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).event.actorId, "guest"); assert.deepEqual(auditRecovery(f.store), saved);
  assert.equal((await post("owner", f.update("http-offer"))).status, 409);
  assert.equal((await post("producer", f.update("http-offer"))).status, 201);
});

async function race(t, f, jobs) {
  const barrier = new SharedArrayBuffer(4);
  const workers = jobs.map(([actor, command]) => new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');
    import(d.module).then(({RoomStore})=>{ const store=new RoomStore(d.filename,{now:()=>d.now});
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),0,0);
      try{parentPort.postMessage({result:store.command(d.token,'commons',d.command)});}
      catch(e){parentPort.postMessage({error:{status:e.status,code:e.code,message:e.message}});}
      finally{store.close();}
    });`, { eval: true, workerData: { module: new URL("../server/store.mjs", import.meta.url).href,
    filename: f.filename, now: f.now, token: f.keys[actor], command, barrier } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  const finished = workers.map(w => new Promise((resolve, reject) => { w.on("message", value => { if (!value.ready) resolve(value); }); w.once("error", reject); }));
  await Promise.all(workers.map(w => new Promise((resolve, reject) => { w.on("message", value => { if (value.ready) resolve(); }); w.once("error", reject); })));
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, workers.length);
  return Promise.all(finished);
}

for (const scenario of ["selection", "last-pending-slot", "member-limit-across-work"]) test(`independent database connections race ${scenario} inside the transaction`, { timeout: 15000 }, async t => {
  const f = setup(t); let jobs;
  if (scenario === "selection") {
    f.send("guest", f.open("first")); f.send("owner", f.open("second"));
    jobs = [["producer", f.update("first")], ["producer", f.update("second")]];
  } else if (scenario === "last-pending-slot") {
    for (let i = 0; i < 6; i++) f.add(`helper-${i}`);
    for (let i = 0; i < 4; i++) f.send(`helper-${i}`, f.open(`offer-${i}`));
    jobs = [["helper-4", f.open("last-a")], ["helper-5", f.open("last-b")]];
  } else {
    jobs = [];
    for (let i = 0; i < 6; i++) {
      const id = `other-work-${i}`;
      f.send("owner", f.command("work.proposed", { workItemId: id, title: id, definitionOfDone: "Two ideas", accountableMemberId: "producer" }));
      f.send("producer", f.command("work.accepted", { workItemId: id, expectedRevision: 0 }));
      const help = f.send("producer", f.command("work.help_updated", { workItemId: id, expectedRevision: 1, expectedHelpRevision: 0,
        status: "open", scope: "Two ideas", expiresAt: new Date(f.now + 3600000).toISOString() }));
      const offer = f.open(`offer-${i}`); Object.assign(offer.data, { workItemId: id, helpEventId: help.event.id });
      if (i < 4) f.send("guest", offer); else jobs.push(["guest", offer]);
    }
  }
  const results = await race(t, f, jobs), winner = results.findIndex(r => r.result);
  assert.equal(results.filter(r => r.result).length, 1); assert.equal(results[1 - winner].error.status, 409);
  const rows = Object.values(f.store.room("commons").state.helpOffers);
  assert.equal(rows.filter(r => r.status === (scenario === "selection" ? "selected" : "offered")).length, scenario === "selection" ? 1 : 5);
  const before = auditRecovery(f.store), [actor, c] = jobs[winner];
  assert.deepEqual(f.send(actor, c).event, results[winner].result.event); assert.deepEqual(auditRecovery(f.store), before);
});

test("failed offer receipt persistence rolls back the event and projection before retry", t => {
  const f = setup(t), before = auditRecovery(f.store), command = f.open("rollback-offer");
  f.store.db.exec("CREATE TRIGGER fail_offer_receipt BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  try { assert.throws(() => f.send("guest", command), /synthetic receipt failure/); }
  finally { f.store.db.exec("DROP TRIGGER fail_offer_receipt"); }
  assert.deepEqual(auditRecovery(f.store), before);
  assert.equal(f.send("guest", command).duplicate, false);
  assert.equal(f.send("guest", command).duplicate, true);
});

for (const corruption of ["scope", "helper", "helper-revision", "offer-revision", "selected-by", "unrecorded-release", "event-actor", "missing-opening", "missing-selection"]) test(`offer history rejects ${corruption} behind a checkpoint`, t => {
  const f = setup(t); f.send("guest", f.open("offer")); f.send("producer", f.update("offer"));
  const room = f.store.room("commons"), state = room.state;
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(state));
  auditRecovery(f.store);
  if (["event-actor", "missing-opening", "missing-selection"].includes(corruption)) {
    const type = corruption === "missing-opening" ? "work.help_offer_opened" : "work.help_offer_updated";
    const row = f.store.db.prepare("SELECT sequence,body FROM events WHERE json_extract(body,'$.type')=?").get(type), e = JSON.parse(row.body);
    if (corruption === "event-actor") e.actorId = "owner";
    else { e.type = "message.posted"; e.data = { body: "Ordinary text" }; }
    f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(e), row.sequence);
  } else {
    const offer = state.helpOffers.offer;
    if (corruption === "scope") offer.invitation.scope = "Unapproved scope";
    if (corruption === "helper") state.members.guest.kind = "agent";
    if (corruption === "helper-revision") state.members.guest.revision++;
    if (corruption === "offer-revision") offer.revision++;
    if (corruption === "selected-by") offer.updatedById = "owner";
    if (corruption === "unrecorded-release") { offer.status = "released"; offer.revision = 2; offer.externalActivityUnverified = true; }
    for (const table of ["rooms", "projection_checkpoints"]) f.store.db.prepare(`UPDATE ${table} SET projection=?`).run(JSON.stringify(state));
  }
  assert.throws(() => auditRecovery(f.store));
  assert.throws(() => new RoomStore(f.filename)); assert.throws(() => new RoomStore(f.filename, { readOnly: true }));
});

test("event/projection capacity allows only valid offer cleanup with exact receipts", t => {
  const f = setup(t); f.send("guest", f.open("selected")); f.send("owner", f.open("pending")); f.send("producer", f.update("selected"));
  const state = f.store.room("commons").state; state.messages.push({ body: "x".repeat(4 * 1024 * 1024) });
  // Synthetic capacity projection only; not evidence of recoverable history.
  f.store.db.prepare("UPDATE rooms SET sequence=10000,projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.throws(() => f.send("producer", f.update("pending")), { code: "pilot_limit" });
  const invalid = f.update("selected", "released"); invalid.data.externalActivityUnverified = false;
  assert.throws(() => f.send("guest", invalid), { status: 422 });
  const release = f.update("selected", "released"); f.send("guest", release); assert.equal(f.send("guest", release).duplicate, true);
  f.send("owner", f.update("pending", "withdrawn"));
  assert.throws(() => f.send("guest", f.open()), { code: "pilot_limit" });
});

test("genuine schema13 rejects offer commands and upgrades only collision-free retained data", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-offer-migration-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), runtime = join(directory, "v13");
  createRuntimePackage({ repository, commit: v13OfferBaseline, destination: runtime });
  const createFixture = await frozenAcceptanceFixture(repository, runtime, v13OfferBaseline);
  for (const target of ["ordinary", "projection-null", "checkpoint-empty", "opening-event", "update-event"]) {
    const f = createFixture();
    try {
      const filename = join(f.directory, "room.sqlite"), row = f.store.room("commons");
      for (const type of ["work.help_offer_opened", "work.help_offer_updated"]) assert.throws(() => f.store.command(f.keys.guest, "commons", { id: crypto.randomUUID(), type, data: { workItemId } }), { status: 422 });
      if (target === "projection-null") { row.state.helpOffers = null; f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(row.state)); }
      if (target === "checkpoint-empty") { row.state.helpOffers = {}; f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", row.sequence, JSON.stringify(row.state)); }
      if (target.endsWith("event")) {
        const e = f.store.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' LIMIT 1").get(), body = JSON.parse(e.body);
        body.type = target === "opening-event" ? "work.help_offer_opened" : "work.help_offer_updated";
        f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(body), e.sequence);
      }
      const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      if (target !== "ordinary") {
        assert.throws(() => new RoomStore(filename), /Legacy help offer field/);
        assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 13);
        assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
      } else {
        const current = new RoomStore(filename);
        try { assert.equal(auditRecovery(current).schemaVersion, 25); assert.deepEqual(current.room("commons"), row); }
        finally { current.close(); }
      }
    } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});
