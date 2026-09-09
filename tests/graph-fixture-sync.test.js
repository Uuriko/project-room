import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { RecordedGraphMailbox, prepareGraphFixturePage, graphFixtureStart, qualifyGraphFixtureCursor } from "../server/graph-fixture-sync.mjs";
import { emailSourceId } from "../server/email-envelope.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.raw = emailContractFixture(); f.raw.connection.accountId = f.store.accountForMember("commons", "owner").id;
  const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(f.raw.connection.accountId), 0) };
  f.apply = request => f.store.email.apply(f.auth.token, request, f.auth.sessionBinding);
  f.configure = () => f.apply({ action: "connection.configure", requestId: "configure-" + f.raw.connection.revision,
    connectionId: f.raw.connection.id, expectedRevision: f.raw.connection.revision - 1, profile: f.raw.connection });
  f.configure();
  f.start = () => graphFixtureStart(f.raw.connection, f.raw.message.parentFolderId);
  f.cursor = suffix => f.start() + "?$deltatoken=" + suffix;
  f.recording = (input = null, suffix = "complete", complete = true) => ({ connection: f.raw.connection,
    pages: [{ cursor: input, response: { status: 200, body: { value: [{ id: f.raw.message.id }],
      [complete ? "@odata.deltaLink" : "@odata.nextLink"]: f.cursor(suffix) } } }],
    messages: [{ id: f.raw.message.id, response: { status: 200, message: f.raw.message, options: f.raw.options } }] });
  f.prepare = (reader, extra = {}) => prepareGraphFixturePage({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding,
    connectionId: f.raw.connection.id, folderId: f.raw.message.parentFolderId, reader, ...extra });
  f.read = () => f.store.inbox.read(f.auth.token, emailSourceId(f.raw.connection, f.raw.message.id), f.auth.sessionBinding);
  f.save = () => f.store.inbox.apply(f.auth.token, { action: "draft.save", requestId: "private-draft", sourceId: f.read().source.id,
    sourceRevision: f.read().source.revision, expectedRevision: 0, body: "Keep this private reply" }, f.auth.sessionBinding);
  return f;
}
test("recorded pages hydrate duplicate invalidations once and retain an exact retry across restart", async t => {
  const f = fixture(t), recording = f.recording(null, "next", false);
  recording.pages[0].response.body.value.push({ id: f.raw.message.id, "@removed": { reason: "deleted" } }, { id: f.raw.message.id });
  let reads = 0;
  class CountingReader extends RecordedGraphMailbox { async message(id) { reads++; return super.message(id); } }
  const before = auditRecovery(f.store), request = await f.prepare(new CountingReader(recording));
  assert.equal(reads, 1); assert.equal(request.observations.length, 1);
  assert.equal(request.observations[0].expectedSourceRevision, 0);
  assert.deepEqual(auditRecovery(f.store), before, "preparing a page has no persistent side effects");
  f.apply(request); f.save(); const after = auditRecovery(f.store);
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.equal(f.apply(request).duplicate, true); assert.deepEqual(auditRecovery(f.store), after);
  assert.equal(f.read().draft.body, "Keep this private reply");
  const next = await f.prepare(new RecordedGraphMailbox(f.recording(request.cursor)));
  f.apply(next); assert.equal(f.read().source.revision, 1);
  assert.equal(f.store.email.verify().folders, 1);
});
test("expired cursor leaves all data unchanged; explicit rescan preserves a private draft", async t => {
  const f = fixture(t), request = await f.prepare(new RecordedGraphMailbox(f.recording())); f.apply(request); f.save();
  const before = auditRecovery(f.store), recording = f.recording(request.cursor);
  recording.pages[0].response = { status: 410, code: "syncStateNotFound" };
  await assert.rejects(f.prepare(new RecordedGraphMailbox(recording)), { code: "email_sync_reset_required" });
  assert.deepEqual(auditRecovery(f.store), before);
  const reset = f.recording(null, "reset"); reset.pages[0].response.body.value = [];
  f.apply(await f.prepare(new RecordedGraphMailbox(reset), { reset: true }));
  assert.equal(f.read().draft.body, "Keep this private reply");
  assert.deepEqual(f.store.email.state(f.auth.token, request.connectionId, request.folderId, f.auth.sessionBinding).folder.members, []);
});
test("recording timeouts, unknown absence and out-of-scope next links never consume progress", async t => {
  const f = fixture(t), before = auditRecovery(f.store);
  for (const alter of [
    r => { r.pages[0].response.status = 503; },
    r => { r.pages[0].response.body["@odata.deltaLink"] = "https://elsewhere.example.test/private"; },
    r => { r.messages[0].response = { status: 404, code: "Unknown" }; },
    r => { r.messages[0].response.message.id = "wrong-message"; },
    r => { r.messages[0].response.options.idType = "mutable"; }
  ]) {
    const recording = structuredClone(f.recording()); alter(recording);
    await assert.rejects(f.prepare(new RecordedGraphMailbox(recording)));
    assert.deepEqual(auditRecovery(f.store), before);
  }
  const reader = new RecordedGraphMailbox(f.recording());
  reader.page = async () => { throw new Error("recorded timeout"); };
  await assert.rejects(f.prepare(reader), /recorded timeout/); assert.deepEqual(auditRecovery(f.store), before);
});
test("current hydration overrides old removed markers; confirmed absence or moved mail never deletes drafts", async t => {
  const f = fixture(t); f.apply(await f.prepare(new RecordedGraphMailbox(f.recording()))); f.save();
  const removed = f.recording(f.cursor("complete"), "removed");
  removed.pages[0].response.body.value = [{ id: f.raw.message.id, "@removed": { reason: "deleted" } }];
  const current = await f.prepare(new RecordedGraphMailbox(removed));
  assert.equal(current.observations[0].kind, "message"); f.apply(current);
  const moved = structuredClone(f.recording(current.cursor, "moved")); moved.messages[0].response.message.parentFolderId = "elsewhere";
  const absent = await f.prepare(new RecordedGraphMailbox(moved));
  assert.equal(absent.observations[0].kind, "absent"); f.apply(absent);
  assert.equal(f.read().draft.body, "Keep this private reply"); assert.equal(f.read().source.revision, 1);
  const missing = f.recording(absent.cursor, "missing");
  missing.messages[0].response = { status: 404, code: "ErrorItemNotFound" };
  f.apply(await f.prepare(new RecordedGraphMailbox(missing)));
  assert.equal(f.read().source.revision, 1); f.store.email.verify();
});
test("disconnect during hydration refuses the prepared page and cannot resurrect connection authority", async t => {
  const f = fixture(t), reader = new RecordedGraphMailbox(f.recording());
  const original = reader.message.bind(reader);
  reader.message = async id => {
    const response = await original(id);
    f.apply({ action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 });
    return response;
  };
  await assert.rejects(f.prepare(reader), { code: "email_connection_changed" });
  assert.equal(f.store.email.verify().sources, 0);
  f.raw.connection.revision = 3;
  f.apply({ action: "connection.configure", requestId: "reconnect", connectionId: f.raw.connection.id, expectedRevision: 2, profile: f.raw.connection });
  await assert.rejects(f.prepare(reader), { code: "email_recording_scope_changed" });
  f.apply(await f.prepare(new RecordedGraphMailbox(f.recording())));
  assert.equal(f.read().source.envelope.connection.revision, 3);
});
test("a cross-folder race after capture rejects stale hydration; preparing again fetches fresh content", async t => {
  const f = fixture(t); f.apply(await f.prepare(new RecordedGraphMailbox(f.recording())));
  const oldFolder = f.raw.message.parentFolderId, oldCursor = f.cursor("complete");
  const reader = new RecordedGraphMailbox(f.recording(oldCursor, "late"));
  const original = reader.message.bind(reader); let raced = false;
  reader.message = async id => {
    const response = await original(id);
    if (!raced) {
      raced = true; f.raw.message.parentFolderId = "archive"; f.raw.message.body.content = "Newer current content";
      f.raw.message.changeKey = "new-version"; f.raw.options.attachmentObservation.messageRevision = "new-version";
      f.apply(await f.prepare(new RecordedGraphMailbox(f.recording())));
      f.raw.message.parentFolderId = oldFolder;
    }
    return response;
  };
  const late = await f.prepare(reader), before = auditRecovery(f.store);
  assert.equal(late.observations[0].expectedSourceRevision, 1);
  assert.throws(() => f.apply(late), { code: "stale_email_source" });
  assert.deepEqual(auditRecovery(f.store), before); assert.equal(f.read().source.envelope.body.content, "Newer current content");
  const fresh = await f.prepare(new RecordedGraphMailbox(f.recording(oldCursor, "fresh")));
  assert.equal(fresh.observations[0].expectedSourceRevision, 2);
  f.apply(fresh); assert.equal(f.read().source.envelope.body.content, "Newer current content");
  f.store.email.verify();
});
test("opaque cursors stay bound to the original mailbox and folder without query rewriting", t => {
  const f = fixture(t), cursor = f.cursor("A%2BB%3D") + "&$select=id%2Csubject";
  assert.equal(qualifyGraphFixtureCursor(cursor, f.raw.connection, f.raw.message.parentFolderId), cursor);
  for (const bad of [cursor.replace("https:", "http:"), cursor.replace("graph.microsoft.com", "graph.microsoft.com.example.test"),
    cursor.replace("/users/", "/me/"), cursor.replace("fixture-mailbox", "another-mailbox"),
    cursor + "#fragment", cursor.replace("https://", "https://user@"), cursor + " "]) {
    assert.throws(() => qualifyGraphFixtureCursor(bad, f.raw.connection, f.raw.message.parentFolderId), { code: "invalid_email_cursor" });
  }
});
test("empty continuation pages advance, repeated nonprogressing pages and oversized batches do not", async t => {
  const f = fixture(t), recording = f.recording(null, "empty-next", false);
  recording.pages[0].response.body.value = [];
  const empty = await f.prepare(new RecordedGraphMailbox(recording)); f.apply(empty);
  assert.equal(f.store.email.verify().sources, 0);
  const repeat = f.recording(empty.cursor, "empty-next", false); repeat.pages[0].response.body.value = [];
  const before = auditRecovery(f.store);
  const repeated = await f.prepare(new RecordedGraphMailbox(repeat));
  assert.throws(() => f.apply(repeated), { code: "nonprogressing_email_page" });
  const large = f.recording(empty.cursor, "too-large"); large.pages[0].response.body.value = Array.from({ length: 51 }, (_, i) => ({ id: "message-" + i }));
  await assert.rejects(f.prepare(new RecordedGraphMailbox(large)), { code: "email_sync_page_limit" });
  assert.deepEqual(auditRecovery(f.store), before);
});
test("room credentials and account revocation refuse hydration without recording private data", async t => {
  const f = fixture(t); let reads = 0;
  const reader = new RecordedGraphMailbox(f.recording()), original = reader.page.bind(reader);
  reader.page = async cursor => { reads++; const page = await original(cursor);
    f.store.changeAccountAccess(f.raw.connection.accountId, { active: false, expectedRevision: 0, reason: "End fixture" }); return page; };
  await assert.rejects(prepareGraphFixturePage({ store: f.store, token: f.keys.agent, binding: f.auth.sessionBinding, reader,
    connectionId: f.raw.connection.id, folderId: f.raw.message.parentFolderId }), { status: 401 });
  assert.equal(reads, 0);
  await assert.rejects(f.prepare(reader), { status: 401 });
  assert.equal(reads, 1); assert.equal(f.store.email.verify().sources, 0);
});
test("a cold allowlisted package prepares and commits the recorded email without checkout dependencies", async t => {
  const f = fixture(t), candidate = candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory);
  const destination = join(f.directory, "cold-driver"); createRuntimePackage({ ...candidate, destination });
  const driver = await import(pathToFileURL(join(destination, "server/graph-fixture-sync.mjs")));
  const { RoomStore: ColdStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const cold = new ColdStore(f.filename);
  try {
    const request = await driver.prepareGraphFixturePage({ store: cold, token: f.auth.token, binding: f.auth.sessionBinding,
      connectionId: f.raw.connection.id, folderId: f.raw.message.parentFolderId, reader: new driver.RecordedGraphMailbox(f.recording()) });
    cold.email.apply(f.auth.token, request, f.auth.sessionBinding);
    assert.equal(f.read().source.envelope.message.subject, f.raw.message.subject); cold.email.verify();
  } finally { cold.close(); }
});
