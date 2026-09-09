import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenRecoveryFixture, v8ConnectionBaseline, v9TextBaseline, v10CharterBaseline, v11ReplyBaseline, v12HelpBaseline, v13OfferBaseline, v14InboxBaseline, v15AdoptionBaseline, v16SendBaseline, v17EmailBaseline, v18EmailSourceBaseline, v19EmailExcerptBaseline, v20ReplyJournalBaseline, v21ReplyReviewBaseline, v22ReplyUpdateBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { AgentConnections } from "../server/agent-connections.mjs";
import { auditRecovery } from "../server/recovery.mjs";

for (const [version, baseline] of [[8, v8ConnectionBaseline], [9, v9TextBaseline], [10, v10CharterBaseline], [11, v11ReplyBaseline], [12, v12HelpBaseline], [13, v13OfferBaseline], [14, v14InboxBaseline], [15, v15AdoptionBaseline], [16, v16SendBaseline], [17, v17EmailBaseline], [18, v18EmailSourceBaseline], [19, v19EmailExcerptBaseline], [20, v20ReplyJournalBaseline], [21, v21ReplyReviewBaseline], [22, v22ReplyUpdateBaseline]]) test(`genuine v${version} data upgrades atomically; old writers cannot write v23`, async t => {
  const root = mkdtempSync(join(tmpdir(), "room-agent-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v8");
  createRuntimePackage({ repository, commit: baseline, destination });
  const createFixture = await frozenRecoveryFixture(repository, destination, baseline), f = createFixture(join(root, "room.sqlite"));
  t.after(() => f.store.close());
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const { auditRecovery: oldAudit } = await import(pathToFileURL(join(destination, "server/recovery.mjs")));
  const before = oldAudit(f.store), catalog = () => f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  const oldCatalog = catalog(), cached = f.store.db.prepare("UPDATE accounts SET revision=revision WHERE id=?");
  assert.equal(cached.run(f.owner.session.account.id).changes, 1);
  const verify = AgentConnections.prototype.verifyHistory;
  let observedVersion;
  AgentConnections.prototype.verifyHistory = function () { observedVersion = this.store.storagePlatform.version(this.store.db); throw new Error("synthetic final failure"); };
  try { assert.throws(() => new RoomStore(f.filename), { code: "connection_integrity_error" }); }
  finally { AgentConnections.prototype.verifyHistory = verify; }
  assert.equal(observedVersion, 23, "fault was injected after installing the new writer");
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, version);
  assert.deepEqual(catalog(), oldCatalog); assert.deepEqual(oldAudit(f.store), before);
  assert.equal(cached.run(f.owner.session.account.id).changes, 1);
  const current = new RoomStore(f.filename, { now: f.now }); t.after(() => current.close());
  assert.deepEqual(auditRecovery(current).tables.filter(row => (version >= 18 || !row.table.startsWith("private_email_")) && (version >= 15 || !row.table.startsWith("private_inbox_")) && (version >= 9 || !row.table.startsWith("agent_connection"))), before.tables);
  assert.deepEqual(current.email.verify(), version >= 18 ? { connections: 1, folders: 1, sources: 1 } : { connections: 0, folders: 0, sources: 0 });
  assert.equal(current.authenticate(f.keys.agent).member.id, "agent");
  assert.throws(() => cached.run(f.owner.session.account.id), /project_room_writer_v(?:9|10|11|12|13|14|17|23)|unsupported database writer/);
  assert.throws(() => new OldStore(f.filename), /newer than this service/);
  current.createAccount("after-v23-upgrade");
  assert.equal(current.account("after-v23-upgrade").active, true);
  assert.equal(auditRecovery(current).schemaVersion, 23);
  if (version >= 21) {
    f.replyRequests.forEach((request, index) => assert.deepEqual(current.inbox.reply(f.owner.token, request, f.owner.session.sessionBinding).receipt, f.replyReceipts[index]));
    const attempt = current.inbox.replyAttempts(f.owner.token, f.emailEnvelope.sourceId, f.owner.session.sessionBinding).attempts[0];
    const retained = f.replyReceipts.at(-1).attempt;
    assert.equal(attempt.status, retained.status); assert.equal(attempt.revision, retained.revision);
    if (version >= 22) assert.equal(attempt.reviewCurrent, true);
  }
  if (version >= 18) {
    const beforeRetry = auditRecovery(current);
    assert.equal(current.email.apply(f.owner.token, f.emailPage, f.owner.session.sessionBinding).duplicate, true);
    assert.deepEqual(auditRecovery(current), beforeRetry);
    if (version === 18) assert.throws(() => current.email.apply(f.owner.token, { ...f.emailPage, requestId: "unfenced-new-page" }, f.owner.session.sessionBinding), { code: "invalid_email_import" });
    const page = { ...f.emailPage, requestId: "fenced-resume-page", expectedRevision: 1, expectedCursor: f.emailPage.cursor,
      cursor: "current-complete", reset: false, complete: true, observations: f.emailPage.observations.map(o => ({ ...o, expectedSourceRevision: 1 })) };
    current.email.apply(f.owner.token, page, f.owner.session.sessionBinding);
    assert.equal(current.inbox.read(f.owner.token, f.emailEnvelope.sourceId, f.owner.session.sessionBinding).draft.body, "Keep this imported-email draft");
    current.email.verify();
  }
  const cursors = current.db.prepare("SELECT * FROM cursors ORDER BY room_id,member_id").all();
  const question = { id: "upgrade-question", type: "message.posted", data: { messageId: "upgrade-question-message",
    body: "Can you check these instructions?", requestKind: "reply", toMemberId: "agent" } };
  const asked = current.command(f.keys.owner, "commons", question);
  const answer = { id: "upgrade-answer", type: "message.posted", data: { messageId: "upgrade-answer-message", body: "Checked — here is my answer.",
    responseToRequestId: question.data.messageId, expectedRequestRevision: 0, responseOutcome: "answered",
    contextEventId: asked.event.id, contextSequence: asked.sequence, replyToId: question.data.messageId, toMemberId: "owner", workItemId: null } };
  const answered = current.command(f.keys.agent, "commons", answer), afterAnswer = auditRecovery(current);
  const resumed = new RoomStore(f.filename, { now: f.now });
  try {
    assert.equal(resumed.command(f.keys.owner, "commons", question).event.id, asked.event.id);
    assert.equal(resumed.command(f.keys.agent, "commons", answer).event.id, answered.event.id);
    assert.deepEqual(auditRecovery(resumed), afterAnswer, "exact retries after restart do not write");
    assert.deepEqual(resumed.db.prepare("SELECT * FROM cursors ORDER BY room_id,member_id").all(), cursors);
    const state = resumed.room("commons").state, request = state.replyRequests[question.data.messageId];
    assert.equal(request.status, "answered"); assert.equal(request.terminalActorId, "agent");
    assert.equal(state.messages.find(message => message.id === request.responseMessageId).body, answer.data.body);
  } finally { resumed.close(); }
  if (version >= 9) {
    const check = store => {
      assert.equal(store.authenticate(f.enrollmentToken).member.id, "managed-agent");
      assert.equal(store.agentConnections.apply(f.owner.token, "commons", f.enrollmentRequest, f.owner.session.sessionBinding).duplicate, true);
      assert.equal(store.command(f.keys.owner, "commons", f.command).duplicate, true);
      if (version >= 10) {
        assert.equal(store.command(f.keys.owner, "commons", f.nativeCommand).event.id, f.nativeCompletion.event.id);
        assert.equal(store.workResult(f.keys.owner, "commons", f.nativeCommand.data.workItemId).result.text.body, f.nativeBody);
      }
      if (version >= 11) {
        assert.equal(store.command(f.keys.owner, "commons", f.charterCommand).event.id, f.charterSaved.event.id);
        assert.equal(store.charter(f.keys.owner, "commons", { revision: 1 }).charter.purpose, f.charterCommand.data.purpose);
      }
    };
    check(current);
    const reopened = new RoomStore(f.filename, { now: f.now }); try { check(reopened); } finally { reopened.close(); }
  }
});

test("genuine v11 legacy request-like fields stay ordinary, while reserved markers refuse before any migration write", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-reply-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v11");
  createRuntimePackage({ repository, commit: v11ReplyBaseline, destination });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const { initialRoom } = await import(pathToFileURL(join(destination, "server/bootstrap.mjs")));
  const { event } = await import(pathToFileURL(join(destination, "src/events.js")));
  for (const variant of ["ordinary", "marker-one", "marker-null", "projection", "checkpoint"]) {
    const filename = join(root, variant + ".sqlite"), old = new OldStore(filename);
    const data = { body: "Old ignored extensions", requestKind: "reply", expectedRequestRevision: "not-a-revision", contextSequence: 99 };
    if (variant === "marker-one") data.requestPolicyVersion = 1;
    if (variant === "marker-null") data.requestPolicyVersion = null;
    old.initialize([...initialRoom(), event({ roomId: "commons", actorId: "owner", type: "message.posted", data })]);
    const state = old.room("commons").state, sequence = old.room("commons").sequence;
    if (variant === "projection") {
      state.replyRequests = {};
      old.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
    }
    const checkpoint = structuredClone(old.room("commons").state);
    if (variant === "checkpoint") checkpoint.replyRequests = null;
    old.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", sequence, JSON.stringify(checkpoint));
    const records = () => ({ catalog: old.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      tables: Object.fromEntries(old.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) =>
        [name, old.db.prepare('SELECT * FROM ' + name).all()])) });
    const before = records();
    try {
      if (variant === "ordinary") {
        const current = new RoomStore(filename);
        try {
          assert.equal(Object.hasOwn(current.room("commons").state, "replyRequests"), false);
          for (const [table, rows] of Object.entries(before.tables)) assert.deepEqual(records().tables[table], rows);
          assert.ok(Object.entries(records().tables).filter(([table]) => table.startsWith("private_inbox_")).every(([, rows]) => rows.length === 0));
          auditRecovery(current);
        } finally { current.close(); }
      } else {
        assert.throws(() => new RoomStore(filename), /Legacy reply request marker/);
        assert.equal(old.db.prepare("PRAGMA user_version").get().user_version, 11);
        assert.deepEqual(records(), before, variant + " leaves schema and all rows unchanged");
      }
    } finally { old.close(); }
  }
});
