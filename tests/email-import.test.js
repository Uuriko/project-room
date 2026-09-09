import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { emailImportLimits } from "../server/email-import.mjs";
import { compareRecoveryCaptures } from "../scripts/compare-recovery.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.raw = emailContractFixture(); f.account = f.store.accountForMember("commons", "owner");
  f.raw.connection.accountId = f.account.id;
  f.key = f.store.issueAccountAccessKey(f.account.id); const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.key, 0) };
  f.apply = request => f.store.email.apply(f.auth.token, request, f.auth.sessionBinding);
  f.configure = (expectedRevision = 0) => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.raw.connection.id,
    expectedRevision, profile: structuredClone(f.raw.connection) });
  f.envelope = () => normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  f.state = () => f.store.email.state(f.auth.token, f.raw.connection.id, f.raw.message.parentFolderId, f.auth.sessionBinding);
  f.page = (extra = {}) => {
    const state = f.state();
    return { action: "page.apply", requestId: randomUUID(), connectionId: f.raw.connection.id, connectionRevision: f.raw.connection.revision,
      folderId: f.raw.message.parentFolderId, expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor,
      cursor: randomUUID(), reset: state.needsReset, complete: true, observations: [{ kind: "message", envelope: f.envelope() }], ...extra };
  };
  f.read = () => f.store.inbox.read(f.auth.token, f.envelope().sourceId, f.auth.sessionBinding);
  f.draft = body => f.store.inbox.apply(f.auth.token, { action: "draft.save", requestId: randomUUID(), sourceId: f.envelope().sourceId,
    sourceRevision: f.read().source.revision, expectedRevision: f.read().draft?.revision ?? 0, body }, f.auth.sessionBinding);
  return f;
}
test("fixture email import reuses private Inbox storage without changing rooms or old-client lists", t => {
  const f = fixture(t), before = f.store.room("commons"); f.configure();
  const request = f.page(), result = f.apply(request), source = f.read().source;
  assert.equal(source.adapter, "email"); assert.deepEqual(source.envelope, f.envelope());
  assert.equal(result.receipt.imports[0].sourceRevision, 1);
  assert.deepEqual(f.store.inbox.list(f.auth.token, f.auth.sessionBinding).sources, []);
  assert.equal(f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeEmail: true }).sources[0].subject, f.raw.message.subject);
  assert.deepEqual(f.store.room("commons"), before);
  assert.deepEqual(f.store.email.verify(), { connections: 1, folders: 1, sources: 1 });
  assert.equal(auditRecovery(f.store).schemaVersion, 18);
});
test("exact page retries and unchanged observations do not create another source revision", t => {
  const f = fixture(t); f.configure(); const request = f.page(), original = f.apply(request);
  const before = auditRecovery(f.store);
  assert.equal(f.apply(request).duplicate, true); assert.deepEqual(f.apply(request).receipt, original.receipt);
  assert.deepEqual(auditRecovery(f.store), before);
  const repeated = f.apply(f.page()); assert.equal(repeated.receipt.imports[0].inboxRequestId, null);
  assert.equal(f.read().source.revision, 1); assert.equal(f.state().folder.revision, 2);
  assert.throws(() => f.apply({ ...request, cursor: "different" }), { code: "idempotency_conflict" });
  f.store.email.verify();
});
test("changed email retains the exact old private draft and requires a current source revision", t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Keep my private answer");
  f.raw.message.body.content = "An updated private request"; f.raw.message.changeKey = "updated-version";
  f.raw.options.attachmentObservation.messageRevision = f.raw.message.changeKey;
  f.apply(f.page());
  assert.equal(f.read().source.revision, 2); assert.equal(f.read().draft.sourceRevision, 1);
  assert.equal(f.read().draft.body, "Keep my private answer");
  assert.throws(() => f.store.inbox.apply(f.auth.token, { action: "draft.save", requestId: "old-draft", sourceId: f.envelope().sourceId,
    sourceRevision: 1, expectedRevision: 1, body: "Overwrite" }, f.auth.sessionBinding), { code: "stale_inbox_source" });
  f.draft("Reviewed new request"); assert.equal(f.read().draft.sourceRevision, 2);
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.equal(f.read().draft.body, "Reviewed new request"); f.store.email.verify();
});
test("page journal failure rolls back source versions and sync cursor together", t => {
  const f = fixture(t); f.configure(); const request = f.page(), before = auditRecovery(f.store);
  f.store.db.exec("CREATE TRIGGER email_test_failure BEFORE INSERT ON private_email_commands BEGIN SELECT RAISE(ABORT,'synthetic email journal failure'); END");
  assert.throws(() => f.apply(request), /synthetic email journal failure/);
  f.store.db.exec("DROP TRIGGER email_test_failure");
  assert.deepEqual(auditRecovery(f.store), before); assert.equal(f.state().folder, null);
  assert.equal(f.apply(request).duplicate, false); assert.equal(f.read().source.revision, 1);
});
test("late competing pages cannot advance a newer cursor and separate processes agree", t => {
  const f = fixture(t); f.configure(); const first = f.page(), late = f.page(); f.apply(first);
  const second = new RoomStore(f.filename);
  try {
    assert.throws(() => second.email.apply(f.auth.token, late, f.auth.sessionBinding), { code: "stale_email_page" });
    assert.equal(second.email.apply(f.auth.token, first, f.auth.sessionBinding).duplicate, true);
    assert.equal(second.inbox.read(f.auth.token, f.envelope().sourceId, f.auth.sessionBinding).source.revision, 1);
  } finally { second.close(); }
});
test("disconnect and reconnect fence old observations but keep stored messages and drafts", t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Still mine"); const late = f.page();
  f.apply({ action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 });
  assert.equal(f.state().canImport, false);
  assert.throws(() => f.apply(late), { code: "email_connection_changed" });
  assert.equal(f.read().draft.body, "Still mine");
  f.raw.connection.revision = 3; f.configure(2);
  assert.equal(f.state().canImport, true);
  assert.throws(() => f.apply(late), { code: "email_connection_changed" });
  assert.equal(f.state().needsReset, true); assert.equal(f.state().expectedCursor, null);
  assert.throws(() => f.apply(f.page({ reset: false })), { code: "stale_email_cursor" });
  f.apply(f.page()); assert.equal(f.read().source.revision, 2); assert.equal(f.read().draft.sourceRevision, 1);
  f.store.email.verify();
});
test("folder removals and complete rescan omissions never delete a source or its draft", t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Do not delete this");
  const id = f.raw.message.id;
  f.apply(f.page({ observations: [{ kind: "absent", messageId: id }] }));
  assert.deepEqual(f.state().folder.members, []); assert.equal(f.read().draft.body, "Do not delete this");
  f.apply(f.page()); assert.deepEqual(f.state().folder.members, [id]);
  f.apply(f.page({ reset: true, complete: false, observations: [] }));
  assert.deepEqual(f.state().folder.members, [id]); assert.deepEqual(f.state().folder.scanMembers, []);
  f.apply(f.page({ complete: true, observations: [] }));
  assert.deepEqual(f.state().folder.members, []); assert.equal(f.read().source.revision, 1);
  assert.equal(f.read().draft.body, "Do not delete this"); f.store.email.verify();
});
test("a message moved between folders keeps one source identity and a stale private draft", t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Draft before moving");
  const sourceId = f.envelope().sourceId, originalFolder = f.raw.message.parentFolderId;
  f.apply(f.page({ observations: [{ kind: "absent", messageId: f.raw.message.id }] }));
  f.raw.message.parentFolderId = "archive-folder";
  f.apply(f.page()); assert.equal(f.envelope().sourceId, sourceId);
  assert.equal(f.read().source.revision, 2); assert.equal(f.read().draft.body, "Draft before moving");
  assert.deepEqual(f.store.email.state(f.auth.token, f.raw.connection.id, originalFolder, f.auth.sessionBinding).folder.members, []);
  assert.equal(f.store.email.verify().sources, 1);
});
test("account bindings, epoch changes and room-agent credentials cannot import another mailbox", t => {
  const f = fixture(t); f.configure(); const request = f.page();
  assert.throws(() => f.store.email.apply(f.keys.producer, request, f.auth.sessionBinding), { status: 401 });
  const slot = f.store.createAccountSessionSlot(), guest = f.store.accountForMember("commons", "guest");
  const auth = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0);
  assert.throws(() => f.store.email.state(slot.token, f.raw.connection.id, f.raw.message.parentFolderId, auth.sessionBinding), { status: 404 });
  assert.throws(() => f.store.email.apply(slot.token, { action: "connection.configure", requestId: "other", connectionId: f.raw.connection.id,
    expectedRevision: 0, profile: f.raw.connection }, auth.sessionBinding), { code: "email_account_mismatch" });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "End fixture access" });
  assert.throws(() => f.apply(request), { status: 401 });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "Restore fixture access" });
  const newSlot = f.store.createAccountSessionSlot();
  f.auth = { token: newSlot.token, ...f.store.loginAccountSession(newSlot.token, f.store.issueAccountAccessKey(f.account.id), 0) };
  assert.equal(f.state().canImport, false);
  assert.throws(() => f.apply(request), { code: "email_connection_changed" });
  f.raw.connection.revision = 2; f.configure(1); f.apply(f.page()); f.store.email.verify();
});
test("connection identity cannot silently change mailboxes or duplicate one account's mailbox", t => {
  const f = fixture(t); f.configure();
  assert.throws(() => f.apply({ action: "connection.configure", requestId: "duplicate-mailbox", connectionId: "another-connection",
    expectedRevision: 0, profile: { ...f.raw.connection, id: "another-connection" } }), { code: "email_mailbox_exists" });
  f.raw.connection.revision = 2; f.raw.connection.mailboxId = "another-mailbox";
  assert.throws(() => f.configure(1), { code: "email_mailbox_changed" });
});
test("ordinary Inbox commands cannot import, overwrite channel origin, send or share unqualified email", t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Email draft");
  const sourceId = f.envelope().sourceId, command = { action: "source.import", requestId: "manual-import", sourceId, expectedRevision: 1, data: { adapter: "email", envelope: f.envelope() } };
  assert.throws(() => f.store.inbox.apply(f.auth.token, command, f.auth.sessionBinding), { code: "email_importer_required" });
  assert.throws(() => f.store.inbox.importSource(f.auth.token, command, f.auth.sessionBinding), { code: "email_importer_required" });
  assert.throws(() => f.store.inbox.apply(f.auth.token, { ...command, action: "source.save", data: { adapter: "synthetic", sender: "a", recipient: "b", subject: "c", paragraphs: ["d"] } }, f.auth.sessionBinding), { code: "inbox_source_origin_changed" });
  assert.throws(() => f.store.inbox.sendContext(f.auth.token, sourceId, f.auth.sessionBinding), { code: "email_sending_unavailable" });
  const audience = f.store.inbox.shareContext(f.auth.token, sourceId, "commons", f.auth.sessionBinding);
  assert.throws(() => f.store.inbox.apply(f.auth.token, { action: "source.share", requestId: "share-email", sourceId, sourceRevision: 1,
    roomId: "commons", audienceVersion: audience.audienceVersion, paragraphs: [0] }, f.auth.sessionBinding), { code: "email_sharing_unavailable" });
});
test("bounded malformed or out-of-scope observations roll back without consuming sync progress", t => {
  const f = fixture(t); f.configure(); const before = auditRecovery(f.store), envelope = f.envelope();
  for (const changes of [{ observations: [{ kind: "message", envelope }, { kind: "message", envelope }] },
    { folderId: "wrong-folder" }, { reset: false }, { expectedCursor: "not-current" }, { observations: new Array(2) }]) {
    assert.throws(() => f.apply(f.page(changes))); assert.deepEqual(auditRecovery(f.store), before);
  }
  f.apply(f.page({ complete: false, cursor: "next" }));
  assert.throws(() => f.apply(f.page({ complete: false, cursor: "next" })), { code: "nonprogressing_email_page" });
});
test("populated backup and replay preserve connection, partial scan, imported content and drafts", async t => {
  const f = fixture(t); f.configure(); f.apply(f.page({ complete: false })); f.draft("Recover this answer");
  const before = auditRecovery(f.store), state = f.state(), source = f.read(), backup = await backupRoom(f.filename, f.directory);
  const copy = new RoomStore(backup.filename, { readOnly: true });
  try {
    assert.deepEqual(auditRecovery(copy), before);
    assert.deepEqual(copy.email.state(f.auth.token, f.raw.connection.id, f.raw.message.parentFolderId, f.auth.sessionBinding), state);
    assert.deepEqual(copy.inbox.read(f.auth.token, f.envelope().sourceId, f.auth.sessionBinding), source);
  } finally { copy.close(); }
});
test("email projection tampering and orphan imports require reconciliation", t => {
  const f = fixture(t); f.configure(); f.apply(f.page());
  const row = f.store.db.prepare("SELECT data_json FROM private_email_folders").get(), changed = JSON.parse(row.data_json);
  changed.cursor = "unjournaled";
  f.store.db.prepare("UPDATE private_email_folders SET data_json=?").run(JSON.stringify(changed));
  assert.throws(() => f.store.email.verify(), /reconciliation/);
  f.store.db.prepare("UPDATE private_email_folders SET data_json=?").run(row.data_json);
  f.raw.message.body.content = "Orphaned importer write";
  f.store.transaction(() => f.store.inbox.importSource(f.auth.token, { action: "source.import", requestId: "orphan", sourceId: f.envelope().sourceId,
    expectedRevision: 1, data: { adapter: "email", envelope: f.envelope() } }, f.auth.sessionBinding));
  assert.throws(() => f.store.email.verify(), /reconciliation/);
});
test("a full private import journal permits an exact retry and disconnect, but no new import", t => {
  const f = fixture(t); f.configure(); const request = f.page(); f.apply(request);
  // Synthetic quota fixture only; not valid replay history or a recovery example.
  f.store.db.prepare("INSERT INTO private_email_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
    .run(f.account.id, "quota-fixture", "fixture", JSON.stringify({ padding: "x".repeat(emailImportLimits.journalBytes) }), "{}", 0, Date.now());
  assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.apply(f.page()), { code: "email_import_limit" });
  assert.equal(f.apply({ action: "connection.disconnect", requestId: "disconnect-full-journal", connectionId: f.raw.connection.id, expectedRevision: 1 }).receipt.state, "disconnected");
});
test("offline recovery comparison flags disconnected email authority without emitting private content", async t => {
  const f = fixture(t); f.configure(); f.apply(f.page()); f.draft("Private recovery comparison answer");
  const before = await backupRoom(f.filename, f.directory);
  f.apply({ action: "connection.disconnect", requestId: "comparison-disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 });
  const after = await backupRoom(f.filename, f.directory), report = compareRecoveryCaptures(before.filename, after.filename);
  assert.equal(report.accessDifferences, true); assert.equal(report.reopenAllowed, false);
  assert.equal(report.tables.find(row => row.table === "private_email_connections").changed, 1);
  assert.doesNotMatch(JSON.stringify(report), /Private recovery comparison answer|Private budget|replies@example/);
});
test("cold allowlisted candidate package reopens imported email and resumes the same partial scan", async t => {
  const f = fixture(t); f.configure(); const page = f.page({ complete: false }); f.apply(page); f.draft("Cold package private answer");
  const candidate = candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory);
  const destination = join(f.directory, "email-runtime"); createRuntimePackage({ ...candidate, destination });
  const { RoomStore: ColdStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const cold = new ColdStore(f.filename);
  try {
    assert.equal(cold.email.apply(f.auth.token, page, f.auth.sessionBinding).duplicate, true);
    assert.equal(cold.inbox.read(f.auth.token, f.envelope().sourceId, f.auth.sessionBinding).draft.body, "Cold package private answer");
    const next = f.page({ complete: true, observations: [] }); cold.email.apply(f.auth.token, next, f.auth.sessionBinding);
    assert.equal(cold.email.state(f.auth.token, page.connectionId, page.folderId, f.auth.sessionBinding).folder.complete, true);
    assert.deepEqual(cold.email.verify(), { connections: 1, folders: 1, sources: 1 });
  } finally { cold.close(); }
});
