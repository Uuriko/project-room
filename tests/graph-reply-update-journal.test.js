import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createReplyUpdateFixture } from "../scripts/reply-update-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRoomServer } from "../server/http.mjs";
import { inboxLimits } from "../server/inbox.mjs";
import { transitionReplyAttempt } from "../server/graph-reply-journal.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { frozenAcceptanceFixture, v22ReplyUpdateBaseline } from "../scripts/frozen-runtime-fixture.mjs";

function setup(t) {
  const f = createReplyUpdateFixture(t), { token, binding, sourceId, attemptId } = f.args;
  const apply = request => f.store.inbox.reply(token, request, binding);
  const updates = () => f.store.inbox.replyUpdates(token, sourceId, binding).updates;
  const reserve = () => {
    const proposal = f.prepare({ requestId: randomUUID() });
    return { action: "reply.update.reserve", requestId: proposal.requestId, sourceId, attemptId,
      expectedRevision: proposal.attemptRevision, updateVersion: proposal.updateVersion };
  };
  const command = (action, update = updates().at(-1)) => ({ action: "reply.update." + action,
    requestId: randomUUID(), sourceId, attemptId, updateId: update.id, expectedRevision: update.revision });
  const observe = (response = f.response(), request = command("observed")) => {
    const { action, ...rest } = request;
    return f.store.inbox.recordReplyUpdateObservation(token, { ...rest, response }, binding);
  };
  return { ...f, apply, updates, reserve, command, observe, filename: join(f.directory, "room.sqlite") };
}

test("durable child preserves all three versions and exact retry without changing the parent or local writing", async t => {
  const f = setup(t); f.save("My edited reply 🪷");
  const parent = f.attempt(), request = f.reserve(), before = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding);
  const saved = f.apply(request), update = saved.receipt.update, audit = auditRecovery(f.store);
  assert.equal(update.status, "reserved"); assert.equal(update.revision, 0);
  assert.equal(update.proposal.original.body, parent.plan.expected.body);
  assert.equal(update.proposal.proposed.body, before.draft.body);
  assert.equal(f.apply(request).duplicate, true);
  assert.deepEqual(f.apply(request).receipt, saved.receipt); assert.deepEqual(auditRecovery(f.store), audit);
  assert.deepEqual(f.attempt(), parent); assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), before);
  assert.throws(() => f.apply({ ...request, updateVersion: "f".repeat(64) }), { code: "idempotency_conflict" });
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_unresolved" });
  for (const key of ["canExecute", "canRetryUpdate", "canReview", "canSend"]) assert.equal(update[key], false);
  const backup = await backupRoom(f.filename, f.directory), restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), audit); } finally { restored.close(); }
});

test("no-op proposals never reserve; current local/source/observation versions bind reservation and dispatch", t => {
  const f = setup(t);
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_not_needed" });
  f.save("First edit"); const stale = f.reserve(); f.save("New edit");
  assert.throws(() => f.apply(stale), { code: "stale_email_reply_update" });
  f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.save("Yet another edit");
  assert.throws(() => f.apply(dispatch), { code: "stale_email_reply_update" });
  assert.equal(f.updates()[0].status, "reserved"); f.apply(f.command("cancel"));
  f.apply(f.reserve()); const late = f.command("dispatch"); f.seed.observe();
  assert.throws(() => f.apply(late), { code: "stale_reply_attempt" });
  assert.equal(f.updates().at(-1).status, "reserved"); auditRecovery(f.store);
});

test("cancellation stays available after disconnection, including at capacity, and releases only a never-dispatched child", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve());
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id,
    expectedRevision: 1 }, f.args.binding);
  assert.throws(() => f.apply(f.command("dispatch")), { code: "email_connection_changed" });
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  try { assert.equal(f.apply(f.command("cancel")).receipt.update.status, "cancelled"); }
  finally { f.store.db.prepare = prepare; }
  assert.throws(() => f.apply(f.command("observed")), { code: "invalid_reply_update" });
  auditRecovery(f.store);
});

test("cancel and recompare make a new child without overwriting earlier cancelled intent", t => {
  const f = setup(t); f.save("First"); f.apply(f.reserve()); const first = structuredClone(f.updates()[0]);
  f.apply(f.command("cancel")); f.save("Second"); f.apply(f.reserve());
  assert.equal(f.updates().length, 2); assert.equal(f.updates()[0].proposal.proposed.body, first.proposal.proposed.body);
  assert.equal(f.updates()[0].status, "cancelled"); assert.equal(f.updates()[1].proposal.proposed.body, "Second"); auditRecovery(f.store);
});

test("dispatch intent survives restart; lost acknowledgment, matching readback and unknown readback never permit replay", t => {
  const f = setup(t); f.save("Updated body"); f.apply(f.reserve()); const dispatch = f.command("dispatch"), saved = f.apply(dispatch);
  const parent = structuredClone(f.attempt()), before = auditRecovery(f.store), resumed = new RoomStore(f.filename);
  try {
    assert.equal(resumed.inbox.reply(f.args.token, dispatch, f.args.binding).duplicate, true);
    assert.deepEqual(auditRecovery(resumed), before);
    assert.deepEqual(resumed.inbox.replyUpdates(f.args.token, f.args.sourceId, f.args.binding).updates[0], saved.receipt.update);
  } finally { resumed.close(); }
  const response = f.response(); response.message.body.content = "Updated body";
  const input = f.command("observed"); const recorded = f.observe(response, input);
  assert.equal(recorded.receipt.update.observation.status, "proposal_content_matches");
  assert.equal(recorded.receipt.update.observation.updateOutcome, "unproven");
  assert.equal(recorded.receipt.update.status, "update_unconfirmed");
  assert.equal(f.observe(response, input).duplicate, true);
  assert.throws(() => f.apply(f.command("cancel")), { code: "reply_update_started" });
  assert.throws(() => f.apply(f.command("dispatch")), { code: "reply_update_started" });
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_unresolved" });
  f.observe({ status: 503 });
  assert.equal(f.updates()[0].observation.status, "draft_unavailable"); assert.equal(f.updates()[0].status, "update_unconfirmed");
  assert.deepEqual(f.attempt(), parent); auditRecovery(f.store);
});

test("late child evidence belongs to its old intent, never replaces newer local or parent observations, and refuses stale child revisions", t => {
  const f = setup(t); f.save("Proposed"); f.apply(f.reserve()); f.apply(f.command("dispatch"));
  const late = f.command("observed"), r = f.response(); r.message.body.content = "Proposed";
  f.save("More recent local writing"); f.seed.observe({ body: { format: "text", content: "More recent parent preview" } });
  const parent = f.attempt(), local = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding);
  f.observe(r, late); const audit = auditRecovery(f.store);
  assert.equal(f.updates()[0].observation.status, "proposal_content_matches");
  assert.deepEqual(f.attempt(), parent); assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), local);
  assert.throws(() => f.observe({ status: 503 }, { ...late, requestId: randomUUID() }), { code: "stale_reply_update" });
  assert.deepEqual(auditRecovery(f.store), audit);
});

test("pending updates invalidate old review affordances even if the user restores the original local body", t => {
  const f = setup(t), parent = f.attempt();
  f.apply({ action: "reply.review", requestId: randomUUID(), sourceId: f.args.sourceId, attemptId: parent.id,
    expectedRevision: parent.revision, reviewVersion: parent.observation.reviewVersion });
  assert.equal(f.attempt().reviewCurrent, true);
  f.save("Edited"); f.apply(f.reserve()); f.save(parent.plan.expected.body);
  assert.equal(f.attempt().reviewCurrent, false);
  const context = f.store.inbox.replyReviewContext(f.args.token, f.args.sourceId, f.args.binding);
  assert.equal(context.attempt.canReview, false); assert.equal(context.attempt.review.current, false);
  assert.throws(() => f.apply({ action: "reply.review", requestId: randomUUID(), sourceId: f.args.sourceId, attemptId: parent.id,
    expectedRevision: f.attempt().revision, reviewVersion: parent.observation.reviewVersion }), { code: "reply_update_unresolved" });
  f.apply(f.command("cancel"));
  // Local draft revisions still invalidate the old creation review even after cancellation.
  assert.equal(f.attempt().reviewCurrent, false); auditRecovery(f.store);
});

test("child evidence requires current private authority but tolerates a disconnected original connection", t => {
  const f = setup(t); f.save("Edited"); const reserve = f.reserve(); f.apply(reserve); f.apply(f.command("dispatch"));
  assert.throws(() => f.store.inbox.apply(f.args.token, reserve, f.args.binding), { code: "reply_driver_required" });
  assert.throws(() => f.store.inbox.reply(f.keys.producer, reserve, f.args.binding), { status: 401 });
  const guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0).sessionBinding;
  assert.throws(() => f.store.inbox.replyUpdates(slot.token, f.args.sourceId, binding), { status: 404 });
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 }, f.args.binding);
  assert.doesNotThrow(() => f.observe());
  const retainedResponse = f.response(), retainedRequest = f.command("observed");
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "Fixture revocation" });
  assert.throws(() => f.observe(retainedResponse, retainedRequest), { status: 401 });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "Fixture return" });
  const ownerSlot = f.store.createAccountSessionSlot(), owner = f.store.loginAccountSession(ownerSlot.token, f.store.issueAccountAccessKey(f.account.id), 0);
  const update = f.store.inbox.replyUpdates(ownerSlot.token, f.args.sourceId, owner.sessionBinding).updates[0];
  const { action, ...request } = f.command("observed", update);
  f.store.inbox.recordReplyUpdateObservation(ownerSlot.token, { ...request, response: retainedResponse }, owner.sessionBinding);
  auditRecovery(f.store);
});

test("wrong mailbox/draft, caller authority fields and oversized evidence are refused without writes", t => {
  const f = setup(t); f.save("Edited"); const reserve = f.reserve(), before = auditRecovery(f.store);
  assert.throws(() => transitionReplyAttempt(new Map(), reserve, { at: 1 }), { code: "invalid_reply_attempt" });
  for (const extra of [{ canExecute: true }, { proposal: f.prepare() }, { updateId: "other" }])
    assert.throws(() => f.apply({ ...reserve, ...extra }), { code: "invalid_reply_update" });
  assert.deepEqual(auditRecovery(f.store), before); f.apply(reserve); f.apply(f.command("dispatch"));
  const r = f.response(); r.message.id = "wrong"; r.options.attachmentObservation.messageId = "wrong";
  const after = auditRecovery(f.store);
  assert.throws(() => f.observe(r), { code: "email_reply_identity_changed" });
  const foreign = f.response(); foreign.connection.mailboxId = "other";
  assert.throws(() => f.observe(foreign), { code: "email_reply_scope_changed" });
  assert.throws(() => f.apply({ ...f.command("observed"), observation: "x".repeat(33000) }), { code: "reply_observation_limit" });
  assert.deepEqual(auditRecovery(f.store), after);
});

test("update transitions are atomic, read-only calls cannot write, and historical receipt tampering fails replay", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const before = auditRecovery(f.store);
  assert.throws(() => f.store.readTransaction(() => f.apply(f.command("dispatch"))), /read-only/);
  f.store.db.exec("CREATE TRIGGER test_update_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'fixture update failure'); END");
  assert.throws(() => f.apply(f.command("dispatch")), /fixture update failure/);
  f.store.db.exec("DROP TRIGGER test_update_failure"); assert.deepEqual(auditRecovery(f.store), before);
  f.apply(f.command("dispatch")); f.observe();
  const row = f.store.db.prepare("SELECT sequence,receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.reserve'").get();
  const receipt = JSON.parse(row.receipt_json); receipt.update.proposal.proposed.body = "Rewritten history";
  f.store.db.exec("DROP TRIGGER private_inbox_commands_no_update");
  f.store.db.prepare("UPDATE private_inbox_commands SET receipt_json=? WHERE sequence=?").run(JSON.stringify(receipt), row.sequence);
  f.store.db.exec("CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END");
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

for (const action of ["reserve", "dispatch", "observed"]) test(`independent connections admit one competing child ${action}`, { timeout: 15000 }, async t => {
  const f = setup(t); f.save("Edited");
  if (action !== "reserve") f.apply(f.reserve());
  if (action === "observed") f.apply(f.command("dispatch"));
  const commands = [0, 1].map(() => action === "reserve" ? f.reserve() : action === "observed" ? { ...f.command(action), observation: null } : f.command(action));
  const barrier = new SharedArrayBuffer(4), workers = commands.map(command => new Worker(`
    const {parentPort,workerData:d}=require('node:worker_threads');
    import(d.module).then(({RoomStore})=>{ const store=new RoomStore(d.filename);
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),0,0);
      try { parentPort.postMessage({result:store.inbox.reply(d.token,d.command,d.binding)}); }
      catch(e) { parentPort.postMessage({error:e.code}); } finally { store.close(); }
    });`, { eval: true, workerData: { module: new URL("../server/store.mjs", import.meta.url).href,
      filename: f.filename, token: f.args.token, binding: f.args.binding, command, barrier } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  const ready = [], results = workers.map(w => new Promise((resolve, reject) => {
    ready.push(new Promise(r => w.on("message", m => { if (m.ready) r(); })));
    w.on("message", m => { if (!m.ready) resolve(m); }); w.once("error", reject);
  }));
  await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(o => o.result && !o.result.duplicate).length, 1); assert.equal(outcomes.filter(o => o.error).length, 1);
  assert.equal(f.updates().length, 1); auditRecovery(f.store);
});

test("cold allowlisted runtime recovers child dispatch and evidence without resubmitting", async t => {
  const f = setup(t); f.save("Cold reply"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.observe();
  const before = auditRecovery(f.store), destination = join(f.directory, "update-package");
  createRuntimePackage({ ...candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory), destination });
  const { RoomStore: ColdStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const store = new ColdStore(f.filename);
  try {
    assert.deepEqual(store.inbox.replyUpdates(f.args.token, f.args.sourceId, f.args.binding).updates, f.updates());
    assert.equal(store.inbox.reply(f.args.token, dispatch, f.args.binding).duplicate, true);
    assert.deepEqual(auditRecovery(store), before);
  } finally { store.close(); }
});

test("pre-v23 child namespace collisions refuse migration before touching old rows or fences", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-update-migration-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v22");
  createRuntimePackage({ repository, commit: v22ReplyUpdateBaseline, destination });
  const f = (await frozenAcceptanceFixture(repository, destination, v22ReplyUpdateBaseline))();
  try {
    const account = f.store.accountForMember("commons", "owner");
    f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
      .run(account.id, "collision", "invalid", JSON.stringify({ action: "reply.update.reserve" }), "{}", 0, 1);
    const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v23 reply update history/);
    assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 22);
    assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("HTTP exposes neither update dispatch nor child plans through the existing review projection", async t => {
  const f = setup(t); f.save("Edited"); const request = f.reserve();
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port, session = f.store.authenticateAccountSession(f.args.token, null, f.args.binding);
  const headers = { Cookie: "account_session=" + f.args.token, "X-Session-Binding": f.args.binding,
    "X-CSRF-Token": session.csrf, Origin: origin, "Content-Type": "application/json" };
  const before = auditRecovery(f.store);
  for (const [path, status] of [["/api/inbox/commands", 403], ["/api/inbox/review", 422]]) {
    const response = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(response.status, status);
  }
  assert.deepEqual(auditRecovery(f.store), before); f.apply(request);
  const response = await fetch(origin + "/api/inbox/sources/" + f.args.sourceId + "/reply-review?view=reply-review-v1", { headers });
  const context = await response.json(); assert.equal(response.status, 200); assert.equal(context.attempt.canReview, false);
  assert.doesNotMatch(JSON.stringify(context), /updateVersion|providerDraftId|conditionalWrite|https:\/\/graph/);
});
