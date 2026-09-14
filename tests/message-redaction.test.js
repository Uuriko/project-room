// Issue #6 D6: redaction that survives replay, export, import and restore.
// Deletion stays a tombstone that keeps history (tests/room-export.test.js);
// redaction rewrites the message's post and edits in the log to a SHA-256
// record, so every replay reproduces the redaction and never the text. Also
// the v29 migration that adds message_redactions to genuine v28 data.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenRecoveryFixture, v28RedactionBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore, COMMAND_TYPES } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { classifyCommand } from "../server/action-classes.mjs";
import { textVersion } from "../server/text-results.mjs";
import { renderRoomExportHtml } from "../server/room-export-html.mjs";
import { migrateMessageRedactionsV29, verifyMessageRedactions, rewriteRedacted, historyRedactions, bodySha256 } from "../server/message-redaction.mjs";
import { STORE_SCHEMA_VERSION, applicationTables } from "../server/writer-fence.mjs";
import { applyEvent, event, replay, EVENT_TYPES as T, PERMISSIONS, redactedBody, messageTombstone, pinnedMessages } from "../src/events.js";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const SECRET = "PURGE-ME orchid wording 🪷 7f3a";
const owner = "owner";
const seed = roomId => [
  event({ type: T.ROOM_CREATED, actorId: owner, roomId, data: { roomId, ownerId: owner, title: "Redaction", purpose: "Synthetic redaction test" } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: owner, displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: "a", displayName: "Author", kind: "human", permissions: ["steer"] } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: "b", displayName: "Bystander", kind: "human", permissions: ["steer"] } })
];
const cmd = (store, token, roomId, type, data) => store.command(token, roomId, { id: randomUUID(), type, data });
const message = (store, roomId, id) => store.room(roomId).state.messages.find(m => m.id === id);
const events = (store, roomId) => store.db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? ORDER BY sequence").all(roomId).map(row => ({ ...row, event: JSON.parse(row.body) }));
// Everything the store holds for a room, as text: the test asserts the secret is gone from all of it.
const storedText = store => ["SELECT body AS t FROM events", "SELECT projection AS t FROM rooms", "SELECT projection AS t FROM projection_checkpoints"]
  .flatMap(sql => store.db.prepare(sql).all().map(row => row.t)).join("\n");

test("reducer: a redacted post replays body-less, the redaction event tombstones and pins drop, and text or record never sit together", () => {
  assert.equal(STORE_SCHEMA_VERSION, 29);
  assert.ok(COMMAND_TYPES.includes(T.MESSAGE_REDACTED)); assert.equal(classifyCommand(T.MESSAGE_REDACTED), "act");
  assert.ok(applicationTables.includes("message_redactions"));
  const post = event({ type: T.MESSAGE_POSTED, actorId: "a", roomId: "r", data: { messageId: "m", body: SECRET } });
  const edit = event({ type: T.MESSAGE_EDITED, actorId: "a", roomId: "r", data: { messageId: "m", body: `${SECRET} again`, expectedMessageRevision: 0 } });
  const pin = event({ type: T.MESSAGE_PINNED, actorId: owner, roomId: "r", data: { messageId: "m" } });
  const live = replay([...seed("r"), post, edit, pin]);
  assert.equal(live.messages[0].body, `${SECRET} again`); assert.equal(pinnedMessages(live).length, 1);
  const redaction = event({ type: T.MESSAGE_REDACTED, actorId: owner, roomId: "r", data: { messageId: "m", bodySha256: sha256(`${SECRET} again`) } });
  // Authority and shape: owner or author only, a real hash, a known message, once.
  assert.throws(() => applyEvent(live, { ...redaction, actorId: "b" }), /Only the author or the Room owner can redact/);
  assert.throws(() => applyEvent(live, { ...redaction, data: { messageId: "m", bodySha256: "nope" } }), /SHA-256/);
  assert.throws(() => applyEvent(live, { ...redaction, data: { messageId: "missing", bodySha256: sha256("x") } }), /Message not found/);
  const redacted = applyEvent(live, redaction);
  const m = redacted.messages[0];
  assert.deepEqual([m.body, m.editHistory, m.redactedAt, m.redactedBy, m.bodySha256, m.revision], [null, [], redaction.at, owner, sha256(`${SECRET} again`), 2]);
  assert.equal(pinnedMessages(redacted).length, 0, "the redaction drops the pin");
  assert.equal(messageTombstone(m), "Message redacted");
  assert.throws(() => applyEvent(redacted, { ...redaction, id: randomUUID(), idempotencyKey: randomUUID() }), /already redacted/);
  for (const [type, data] of [[T.MESSAGE_EDITED, { messageId: "m", body: "back", expectedMessageRevision: 2 }], [T.MESSAGE_DELETED, { messageId: "m", expectedMessageRevision: 2 }]]) {
    assert.throws(() => applyEvent(redacted, event({ type, actorId: "a", roomId: "r", data })), /Message was redacted/);
  }
  assert.throws(() => applyEvent(redacted, { ...pin, id: randomUUID(), idempotencyKey: randomUUID() }), /cannot be pinned/);
  // The rewritten log (what the store keeps) replays to the same room, pin included until the redaction.
  const rewritten = [...seed("r"), rewriteRedacted(post, redaction.id), rewriteRedacted(edit, redaction.id), pin, redaction];
  assert.deepEqual(rewritten[5].data, { messageId: "m", expectedMessageRevision: 0, redacted: { bodySha256: sha256(`${SECRET} again`), redactionId: redaction.id } });
  assert.deepEqual(rewritten[4].data, { messageId: "m", redacted: { bodySha256: sha256(SECRET), redactionId: redaction.id } });
  assert.deepEqual(replay(rewritten).messages, redacted.messages);
  assert.deepEqual(replay(rewritten).pins, redacted.pins ?? []);
  assert.deepEqual(historyRedactions(rewritten), [{ messageId: "m", eventId: redaction.id, sequence: 8, bodySha256: redaction.data.bodySha256, at: redaction.at, by: owner }]);
  assert.equal(messageTombstone(replay(rewritten.slice(0, 6)).messages[0]), "Message redacted", "a body-less post at a historical boundary reads as redacted, never as live");
  // A record next to text, a malformed record, or text where the record must be, is refused.
  assert.throws(() => redactedBody({ body: "x", redacted: rewritten[4].data.redacted }), /Invalid redaction record/);
  assert.throws(() => redactedBody({ redacted: { bodySha256: "short", redactionId: redaction.id } }), /Invalid redaction record/);
  assert.equal(redactedBody({ body: "x" }), null);
  assert.throws(() => replay([...seed("r"), rewriteRedacted(post, redaction.id), edit]), /redaction is incomplete/);
  assert.throws(() => replay([...seed("r"), post, rewriteRedacted(edit, redaction.id)]), /redaction is incomplete/);
  assert.throws(() => historyRedactions([...seed("r"), post, edit, redaction]), /still carries text/);
  assert.throws(() => historyRedactions([...seed("r"), rewriteRedacted(post, "elsewhere"), redaction]), /names no redaction event/);
  assert.equal(messageTombstone({ body: "x" }), null); assert.equal(messageTombstone({ body: null, deletedAt: "t" }), "Message deleted"); assert.equal(messageTombstone(undefined), null);
});

test("store: redaction rewrites the log, tombstones the projection, leaves search, is idempotent and is verified on every open", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const { store, keys } = f;
  const before = events(store, "commons").length;
  cmd(store, keys.guest, "commons", T.MESSAGE_POSTED, { messageId: "m", body: SECRET });
  cmd(store, keys.guest, "commons", T.MESSAGE_EDITED, { messageId: "m", body: `${SECRET} edited`, expectedMessageRevision: 0 });
  cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "reply", body: "a reply that stays", replyToId: "m" });
  cmd(store, keys.owner, "commons", T.MESSAGE_PINNED, { messageId: "m" });
  assert.ok(storedText(store).includes(SECRET));
  assert.equal(store.search(keys.owner, "commons", "orchid", "messages").messages.length, 1);
  // Only the author or the owner; the shape takes messageId alone.
  assert.throws(() => cmd(store, keys.producer, "commons", T.MESSAGE_REDACTED, { messageId: "m" }), error => error.status === 422 && error.code === "command_rejected" && /Only the author or the Room owner/.test(error.message));
  assert.throws(() => cmd(store, keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: "m", reason: "x" }), error => error.status === 422 && error.code === "invalid_command");
  assert.throws(() => cmd(store, keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: "nope" }), error => error.status === 422 && /Message not found/.test(error.message));
  const sequence = store.room("commons").sequence;
  const result = cmd(store, keys.guest, "commons", T.MESSAGE_REDACTED, { messageId: "m" });
  assert.equal(result.duplicate, false); assert.equal(result.sequence, sequence + 1);
  assert.deepEqual(result.event.data, { messageId: "m", bodySha256: sha256(`${SECRET} edited`) }, "the hash is of the last body");
  const m = message(store, "commons", "m");
  assert.deepEqual([m.body, m.editHistory, m.redactedBy, m.bodySha256, m.revision], [null, [], "guest", sha256(`${SECRET} edited`), 2]);
  assert.equal(m.redactedAt, result.event.at);
  assert.equal(pinnedMessages(store.room("commons").state).length, 0);
  assert.equal(message(store, "commons", "reply").replyToId, "m", "references to the message still resolve");
  // The log: post and edit rewritten in place (same ids, same sequences), the redaction appended, nothing else touched.
  const log = events(store, "commons");
  assert.equal(log.length, before + 5);
  const post = log.find(row => row.event.type === T.MESSAGE_POSTED && row.event.data.messageId === "m"), edit = log.find(row => row.event.type === T.MESSAGE_EDITED);
  assert.deepEqual(post.event.data, { messageId: "m", redacted: { bodySha256: sha256(SECRET), redactionId: result.event.id } });
  assert.deepEqual(edit.event.data, { messageId: "m", expectedMessageRevision: 0, redacted: { bodySha256: sha256(`${SECRET} edited`), redactionId: result.event.id } });
  assert.equal(post.id, post.event.id); assert.equal(post.sequence, before + 1);
  assert.equal(storedText(store).includes("PURGE-ME"), false, "no copy of the text remains in events, projection or checkpoint");
  assert.equal(store.search(keys.owner, "commons", "orchid", "messages").messages.length, 0);
  assert.equal(store.search(keys.owner, "commons", "stays", "messages").messages.length, 1);
  assert.deepEqual(store.db.prepare("SELECT message_id,event_id,sequence,body_sha256,redacted_by FROM message_redactions").all().map(row => ({ ...row })),
    [{ message_id: "m", event_id: result.event.id, sequence: result.sequence, body_sha256: result.event.data.bodySha256, redacted_by: "guest" }]);
  // Replay from the rewritten log is the stored projection; the recovery audit agrees.
  assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"));
  assert.equal(auditRecovery(store).schemaVersion, 29);
  // Idempotent: a second redaction, by anyone entitled, appends nothing and answers the first.
  const again = cmd(store, keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: "m" });
  assert.deepEqual(again, { sequence: result.sequence, event: result.event, duplicate: true });
  assert.equal(events(store, "commons").length, before + 5);
  assert.equal(store.command(keys.guest, "commons", { id: "same-command", type: T.MESSAGE_REDACTED, data: { messageId: "m" } }).duplicate, true);
  // A redacted message cannot be edited, deleted or pinned; it can still be replied to and reacted to.
  assert.throws(() => cmd(store, keys.guest, "commons", T.MESSAGE_EDITED, { messageId: "m", body: "back", expectedMessageRevision: 2 }), /redacted/);
  assert.throws(() => cmd(store, keys.owner, "commons", T.MESSAGE_DELETED, { messageId: "m", expectedMessageRevision: 2 }), /redacted/);
  assert.throws(() => cmd(store, keys.owner, "commons", T.MESSAGE_PINNED, { messageId: "m" }), /cannot be pinned/);
  cmd(store, keys.owner, "commons", T.MESSAGE_REACTION_SET, { messageId: "m", reaction: "like", active: true });
  cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "later", body: "still replying", replyToId: "m" });
  // A deleted message (tombstone, text kept in the log) can be redacted afterwards; that purges the text.
  cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "d", body: "DELETED-THEN-REDACTED" });
  cmd(store, keys.owner, "commons", T.MESSAGE_DELETED, { messageId: "d", expectedMessageRevision: 0, reason: "hide" });
  assert.ok(storedText(store).includes("DELETED-THEN-REDACTED"), "deletion keeps the text in the log");
  const purge = cmd(store, keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: "d" });
  assert.equal(purge.event.data.bodySha256, sha256("DELETED-THEN-REDACTED"));
  assert.equal(storedText(store).includes("DELETED-THEN-REDACTED"), false);
  assert.deepEqual([message(store, "commons", "d").deletedAt !== undefined, message(store, "commons", "d").redactedBy], [true, "owner"]);
  assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"));
  auditRecovery(store);
  // Verified on every open: text that comes back for a redacted message is refused, writable and read-only alike.
  const filename = join(f.directory, "room.sqlite");
  const tampered = JSON.stringify({ ...post.event, data: { messageId: "m", body: "resurrected" } });
  store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(tampered, post.sequence);
  assert.throws(() => new RoomStore(filename), /Message redaction requires operator reconciliation/);
  assert.throws(() => new RoomStore(filename, { readOnly: true }), /Message redaction requires operator reconciliation/);
  store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(post.body, post.sequence);
  verifyMessageRedactions(store);
  store.db.prepare("DELETE FROM message_redactions WHERE message_id='d'").run();
  assert.throws(() => new RoomStore(filename, { readOnly: true }), /Message redaction requires operator reconciliation/, "a redaction event without its row");
  store.db.prepare("INSERT INTO message_redactions(room_id,message_id,event_id,sequence,body_sha256,redacted_at,redacted_by) VALUES('commons','d',?,?,?,?,'owner')").run(purge.event.id, purge.sequence, purge.event.data.bodySha256, purge.event.at);
  const reopened = new RoomStore(filename, { readOnly: true }); reopened.close();
});

test("HTTP: export carries the redaction and no text, import reproduces it, a tampered import is refused, the readable export and a backup hold no copy", async t => {
  // A plain room (import replaces history, which the acceptance fixture's invitation evidence forbids).
  const directory = mkdtempSync(join(tmpdir(), "room-redaction-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const memberId of ["guest", "producer"]) {
    cmd(store, keys.owner, "commons", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind: "human", permissions: [] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "test-welcome", body: "Welcome; this message stays." });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, f = { directory };
  const request = (path, { method = "GET", data, token, contentType, raw } = {}) => fetch(origin + path, { method,
    headers: { Origin: origin, Authorization: `Bearer ${token}`, ...(data !== undefined || raw !== undefined ? { "Content-Type": contentType ?? "application/json" } : {}) },
    ...(raw !== undefined ? { body: raw } : data !== undefined ? { body: JSON.stringify(data) } : {}) });
  cmd(store, keys.guest, "commons", T.MESSAGE_POSTED, { messageId: "m", body: SECRET });
  const first = await request("/api/rooms/commons/commands", { method: "POST", token: keys.owner, data: { id: "redact-1", type: T.MESSAGE_REDACTED, data: { messageId: "m" } } });
  assert.equal(first.status, 201);
  const receipt = await first.json();
  assert.equal(receipt.event.data.bodySha256, sha256(SECRET));
  const second = await request("/api/rooms/commons/commands", { method: "POST", token: keys.guest, data: { id: "redact-2", type: T.MESSAGE_REDACTED, data: { messageId: "m" } } });
  assert.equal(second.status, 200); assert.equal((await second.json()).duplicate, true);
  const denied = await request("/api/rooms/commons/commands", { method: "POST", token: keys.producer, data: { id: "redact-3", type: T.MESSAGE_REDACTED, data: { messageId: "test-welcome" } } });
  assert.equal(denied.status, 422);
  // JSONL export: the rewritten post, the redaction event, no text; a member can verify a copy against the hash.
  const jsonl = await (await request("/api/rooms/commons/export", { token: keys.producer })).text();
  assert.equal(jsonl.includes("PURGE-ME"), false);
  const lines = jsonl.trim().split("\n").map(line => JSON.parse(line));
  const post = lines.find(line => line.event.type === T.MESSAGE_POSTED && line.event.data.messageId === "m").event;
  assert.deepEqual(post.data, { messageId: "m", redacted: { bodySha256: sha256(SECRET), redactionId: receipt.event.id } });
  assert.equal(lines.find(line => line.event.type === T.MESSAGE_REDACTED).event.data.bodySha256, bodySha256(SECRET), "SHA-256 of the original text verifies the record");
  // Readable export: the tombstone, never the body.
  const html = await (await request("/api/rooms/commons/export?format=html", { token: keys.owner })).text();
  assert.ok(html.includes("Message redacted")); assert.equal(html.includes("PURGE-ME"), false);
  assert.ok(renderRoomExportHtml(lines, { roomId: "commons" }).includes("Message redacted"));
  // Import round-trip (owner): the same file reproduces the redaction and the table row.
  const stateBefore = store.room("commons");
  const imported = await request("/api/rooms/commons/import", { method: "POST", token: keys.owner, raw: jsonl, contentType: "application/x-ndjson" });
  assert.equal(imported.status, 200);
  assert.deepEqual(store.room("commons"), stateBefore);
  assert.equal(storedText(store).includes("PURGE-ME"), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM message_redactions WHERE room_id='commons'").get().n, 1);
  assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"));
  auditRecovery(store);
  // A file that brings the text back for a redacted message does not replay.
  const tampered = lines.map(line => line.event.id === post.id ? { ...line, event: { ...post, data: { messageId: "m", body: "resurrected" } } } : line).map(line => JSON.stringify(line)).join("\n") + "\n";
  const refused = await request("/api/rooms/commons/import", { method: "POST", token: keys.owner, raw: tampered, contentType: "application/x-ndjson" });
  assert.equal(refused.status, 422); assert.match((await refused.json()).error.message, /still carries text/);
  assert.deepEqual(store.room("commons"), stateBefore, "the refused import wrote nothing");
  // A backup taken after the redaction contains no copy of the text and verifies as a restore.
  const backup = await backupRoom(join(f.directory, "room.sqlite"), f.directory);
  assert.equal(readFileSync(backup.filename, "latin1").includes("PURGE-ME"), false);
  const restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.equal(message(restored, "commons", "m").body, null); assert.equal(auditRecovery(restored).schemaVersion, 29); } finally { restored.close(); }
});

test("store: a native text result and a reply request survive redaction — the hash is the content from then on", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const { store, keys } = f;
  cmd(store, keys.owner, "commons", T.WORK_PROPOSED, { workItemId: "w", title: "Native result", definitionOfDone: "Exact text", accountableMemberId: "owner" });
  cmd(store, keys.owner, "commons", T.WORK_ACCEPTED, { workItemId: "w", expectedRevision: 0 });
  const post = cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "draft", workItemId: "w", body: SECRET });
  cmd(store, keys.owner, "commons", T.WORK_COMPLETED, { workItemId: "w", expectedRevision: 1, evidenceKind: "room_text", evidenceMessageId: "draft",
    evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(SECRET), previousCompletionEventId: null, producerId: "owner", summary: "Done", nextAction: "Review" });
  assert.equal(store.workResult(keys.owner, "commons", "w").result.text.body, SECRET);
  // A reply request keeps its request fields when redacted.
  cmd(store, keys.owner, "commons", T.MESSAGE_POSTED, { messageId: "ask", body: `${SECRET} please answer`, toMemberId: "guest", requestKind: "reply" });
  assert.equal(store.room("commons").state.replyRequests.ask.status, "open");
  for (const id of ["draft", "ask"]) cmd(store, keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: id });
  assert.equal(storedText(store).includes("PURGE-ME"), false);
  const result = store.workResult(keys.owner, "commons", "w").result;
  assert.equal(result.kind, "room_text"); assert.equal(result.text.body, null); assert.equal(result.text.byteLength, null);
  assert.equal(result.text.evidenceVersion, `sha256:${sha256(SECRET)}`); assert.equal(result.receipt.evidenceVersion, result.text.evidenceVersion);
  assert.equal(store.room("commons").state.replyRequests.ask.status, "open");
  assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"));
  assert.equal(auditRecovery(store).schemaVersion, 29);
  const reopened = new RoomStore(join(f.directory, "room.sqlite"), { readOnly: true });
  try { assert.equal(auditRecovery(reopened).events, store.room("commons").sequence + reopened.db.prepare("SELECT count(*) AS n FROM events WHERE room_id<>'commons'").get().n); } finally { reopened.close(); }
});

test("store: bootstrap with a redacted history records the obligation; a history with text for a redacted message is refused", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-redaction-init-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  const post = event({ type: T.MESSAGE_POSTED, actorId: "a", roomId: "r", data: { messageId: "m", body: SECRET } });
  const redaction = event({ type: T.MESSAGE_REDACTED, actorId: owner, roomId: "r", data: { messageId: "m", bodySha256: sha256(SECRET) } });
  assert.throws(() => store.initialize([...seed("r"), post, redaction]), /still carries text/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "the failed seed wrote nothing");
  store.initialize([...seed("r"), rewriteRedacted(post, redaction.id), redaction]);
  assert.deepEqual(store.db.prepare("SELECT message_id,event_id,sequence FROM message_redactions").all().map(row => ({ ...row })), [{ message_id: "m", event_id: redaction.id, sequence: 6 }]);
  verifyMessageRedactions(store);
  assert.equal(auditRecovery(store).schemaVersion, 29);
});

test("migration: genuine v28 data gains message_redactions exactly once, keeps every row, and the migration is idempotent", { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "room-redaction-v28-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v28");
  createRuntimePackage({ repository, commit: v28RedactionBaseline, destination });
  const createFixture = await frozenRecoveryFixture(repository, destination, v28RedactionBaseline);
  const f = createFixture(join(root, "room.sqlite"));
  t.after(() => f.store.close());
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const hasTable = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_redactions'").get());
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 28);
  assert.equal(hasTable(f.store.db), false, "the baseline predates the table");
  const rows = Object.fromEntries(["rooms", "events", "projection_checkpoints", "commands"].map(table => [table, f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /requires schema v29/, "read-only never migrates an older backup");
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 28, "the refused read-only open changed nothing");
  const current = new RoomStore(f.filename, { now: f.now });
  t.after(() => current.close());
  assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 29);
  assert.equal(hasTable(current.db), true);
  assert.deepEqual(current.db.prepare("SELECT * FROM message_redactions").all(), [], "pre-v29 stores redacted nothing");
  for (const [table, expected] of Object.entries(rows)) assert.deepEqual(current.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), expected, `${table} is byte-identical`);
  const audit = auditRecovery(current);
  assert.equal(audit.schemaVersion, 29);
  const catalog = () => current.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  const schema = catalog();
  migrateMessageRedactionsV29(current);
  assert.deepEqual(catalog(), schema, "a second run adds nothing");
  assert.deepEqual(auditRecovery(current), audit);
  verifyMessageRedactions(current);
  assert.throws(() => new OldStore(f.filename), /newer than this service/);
  // The upgraded store redacts genuine pre-v29 text, and the old package's text is gone from it.
  const target = current.room("commons").state.messages.find(m => m.body === f.command.data.body);
  cmd(current, f.keys.owner, "commons", T.MESSAGE_REDACTED, { messageId: target.id });
  assert.equal(storedText(current).includes(f.command.data.body), false);
  assert.equal(current.db.prepare("SELECT count(*) AS n FROM message_redactions").get().n, 1);
  assert.equal(auditRecovery(current).schemaVersion, 29);
});
