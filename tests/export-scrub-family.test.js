// Audit conversion, export family (methods audit B7-4 F1–F6/F9 + B2-5-F1):
// one scrub design across export shapes, digest-aware work rebinding,
// honest restore reporting. Every test is the audit's repro, failing-first
// against the base tree (see the wave's lane report for the repro run).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, replayNdjson, tableDigestsOf } from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession } from "../server/restore-ndjson.mjs";
import { recordDirectSend, exportDirectSends } from "../server/inbox-outbox.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createExportScrubContext, placeholderFor, registerSecretValues, scrubText } from "../server/export-scrub.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const mem = () => new RoomStore(null, { database: new DatabaseSync(":memory:") });

const PRI = "pri_abcdefghijklmnop";
const GX = "GX-" + "A".repeat(32);
const SHARE = "S".repeat(43);
const HOOK = "webhook-secret-value-1234567890";
const LOW = "123456";
const OLD_BODY = "OLD-EDITED-AWAY-TEXT";

function seed() {
  const store = mem();
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  cmd(T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work"] });
  cmd(T.WORK_PROPOSED, { workItemId: "w1", title: `rotate ${PRI} now`, definitionOfDone: "done", mode: "write", accountableMemberId: "owner" });
  cmd(T.MESSAGE_POSTED, { messageId: "m-tok", body: `tokens ${PRI} and ${GX} and ${SHARE} and secret ${HOOK}` });
  cmd(T.MESSAGE_POSTED, { messageId: "m-edit", body: OLD_BODY });
  cmd(T.MESSAGE_EDITED, { messageId: "m-edit", body: "new current text", expectedMessageRevision: 0 });
  store.transaction(() => {
    store.db.prepare(`INSERT INTO agent_webhook_subs (subscription_id, agent_id, url, events_json, secret, enabled, created_at)
      VALUES ('sub-1','agent','https://example.com/hook','[]',?,1,1)`).run(HOOK);
    store.db.prepare(`INSERT INTO oauth_pending_states (state_hash, provider, slot_token, expected_revision, verifier, expires_at, link, used, created_at)
      VALUES (?, 'google', ?, 0, ?, 9999999999999, 0, 0, 1)`).run("ab".repeat(32), "slot-token-value-123456", LOW);
  });
  return store;
}

test("F1+F2+F3+F5+F6: the NDJSON export scrubs every shape and value copy, rebinds work digests, drops edited-away text", t => {
  const store = seed();
  t.after(() => store.close());
  const ndjson = exportNdjsonText(store.db);
  for (const leaked of [PRI, GX, SHARE, HOOK, OLD_BODY]) assert.equal(ndjson.includes(leaked), false, leaked);
  assert.equal(ndjson.includes(sha(LOW)), false, "the low-entropy placeholder is not the plain sha256 of '123456'");
  assert.equal(ndjson.includes(LOW), false);
  // Strict restore now succeeds and the room reads back: the work digest
  // was rebound to the scrubbed body, not left pointing at the original.
  const target = mem();
  t.after(() => target.close());
  const result = replayNdjsonInto(ndjson, target);
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  assert.equal(result.readability.ok, true);
  const room = target.room("commons");
  assert.match(room.state.workItems.w1.title, /^rotate [0-9a-f]{64} now$/);
  const messages = target.db.prepare("SELECT body FROM messages").all().map(row => row.body ?? "").join("\n");
  assert.ok(!messages.includes(OLD_BODY));
});

test("B2-5-F1: scrub substitutions are counted in the trailer and surfaced as scrubbedCells on every restore path", t => {
  const store = seed();
  t.after(() => store.close());
  const ndjson = exportNdjsonText(store.db);
  const trailer = ndjson.trim().split("\n").map(line => JSON.parse(line)).find(record => record.kind === "trailer");
  assert.ok(trailer.scrubbedCells, "trailer carries scrub counts");
  assert.ok(trailer.scrubbedCells.messages.body >= 1);
  assert.ok(trailer.scrubbedCells.work_entities.body >= 1);

  const into = mem(); t.after(() => into.close());
  const intoResult = replayNdjsonInto(ndjson, into);
  assert.deepEqual(intoResult.scrubbedCells, trailer.scrubbedCells);
  // sanitizedCells keeps its #3599 meaning (secret-column substitutions only).
  assert.deepEqual(intoResult.sanitizedCells, { agent_webhook_subs: { secret: 1 }, oauth_pending_states: { slot_token: 1, verifier: 1 } });

  const sessionTarget = mem(); t.after(() => sessionTarget.close());
  const session = createBackupReplaySession(sessionTarget);
  session.writeText(ndjson);
  assert.deepEqual(session.finish().scrubbedCells, trailer.scrubbedCells);
});

test("headline: report-mode restore does not certify verified/full over a room that throws on read", t => {
  const store = seed();
  t.after(() => store.close());
  // Rebuild the audit's torn export: a work body that no longer matches
  // its digest, with the trailer's table digests recomputed over the
  // doctored rows exactly as the pre-cure exporter's self-consistent
  // trailer did.
  const records = exportNdjsonText(store.db).trim().split("\n").map(line => JSON.parse(line));
  const byTable = new Map();
  let trailer = null;
  for (const record of records) {
    if (record.kind === "trailer") { trailer = record; continue; }
    if (record.kind === "watermark") continue;
    if (record.table === "work_entities") record.row.body = JSON.stringify({ ...JSON.parse(record.row.body), title: "tampered title" });
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  trailer.tables = tableDigestsOf(byTable);
  delete trailer.scrubbedCells;
  const doctored = [...records.filter(record => record.kind !== "trailer"), trailer].map(record => JSON.stringify(record)).join("\n") + "\n";

  assert.throws(() => replayNdjsonInto(doctored, mem()), /work_projection_corrupt/);
  const target = mem(); t.after(() => target.close());
  const result = replayNdjsonInto(doctored, target, { audit: "report" });
  assert.equal(result.audit.ok, false);
  assert.equal(result.verified, false, "an unreadable room is never certified verified");
  assert.equal(result.contentVerification, "unreadable");
  assert.deepEqual(result.readability.unreadable.map(entry => entry.room), ["commons"]);
  assert.match(result.readability.unreadable[0].error, /work_projection_corrupt/);
  assert.throws(() => target.room("commons"), /work_projection_corrupt/, "the landed room really does throw on read");

  const sessionTarget = mem(); t.after(() => sessionTarget.close());
  const session = createBackupReplaySession(sessionTarget, { audit: "report" });
  session.writeText(doctored);
  const sessionResult = session.finish();
  assert.equal(sessionResult.verified, false);
  assert.equal(sessionResult.contentVerification, "unreadable");
});

test("F4: the send-journal CSV and JSON exports apply the shared scrub", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  recordDirectSend(db, { id: randomUUID(), accountId: "acc-1", channel: "telegram", to: "123456",
    subject: `rotate ${PRI} and ${GX}`, bodyHash: sha("body"), threadId: null, at: 1000 });
  const csv = exportDirectSends(db, "acc-1", { at: 2000 }).text;
  const json = exportDirectSends(db, "acc-1", { format: "json", at: 2000 }).text;
  for (const text of [csv, json]) {
    assert.equal(text.includes(PRI), false);
    assert.equal(text.includes(GX), false);
    assert.match(text, /rotate [0-9a-f]{64} and [0-9a-f]{64}/);
  }
});

test("F6: the OAuth pending-state writer refuses short slot tokens and verifiers", t => {
  const store = mem();
  t.after(() => store.close());
  store.initialize(initialRoom());
  assert.throws(
    () => store.oauthPendingStateCreate({ provider: "google", stateHash: "cd".repeat(32), slotToken: "short", expectedRevision: 0, verifier: LOW, expiresAt: Date.now() + 60000, link: false }),
    error => error.code === "invalid_oauth_pending");
  assert.throws(
    () => store.oauthPendingStateCreate({ provider: "google", stateHash: "cd".repeat(32), slotToken: "s".repeat(43), expectedRevision: 0, verifier: "v".repeat(15), expiresAt: Date.now() + 60000, link: false }),
    error => error.code === "invalid_oauth_pending");
  store.oauthPendingStateCreate({ provider: "google", stateHash: "cd".repeat(32), slotToken: "s".repeat(43), expectedRevision: 0, verifier: "v".repeat(43), expiresAt: Date.now() + 60000, link: false });
});

test("F9: the sqlite file backup executes and its watermark names the raw, unsanitized copy", async t => {
  const directory = mkdtempSync(join(tmpdir(), "export-scrub-f9-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "src.sqlite");
  const store = new RoomStore(source);
  store.initialize(initialRoom());
  store.issueAccessKey("commons", "owner");
  store.close();
  const out = mkdtempSync(join(tmpdir(), "export-scrub-f9-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = await backupRoom(source, out);
  assert.equal(result.verified, true);
  assert.equal(result.sanitized, false);
  const watermark = JSON.parse(readFileSync(result.watermark, "utf8"));
  assert.equal(watermark.sanitization, "none-raw-copy");
});

test("file replay path: a cured export restores verified/full and readable", t => {
  const store = seed();
  t.after(() => store.close());
  const directory = mkdtempSync(join(tmpdir(), "export-scrub-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = replayNdjson(exportNdjsonText(store.db), join(directory, "room.sqlite"), { audit: "report" });
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  assert.equal(result.readability.ok, true);
  assert.ok(result.scrubbedCells.messages.body >= 1);
});

test("export-scrub: shapes, salted placeholders, value-shaped twins, and base64 boundaries", () => {
  const context = createExportScrubContext();
  const scrubbed = scrubText(`a ${PRI} b ${GX} c ${SHARE} d ga1.${"e".repeat(20)}`, context, "messages", "body");
  for (const leaked of [PRI, GX, SHARE]) assert.equal(scrubbed.includes(leaked), false, leaked);
  assert.equal(context.report().messages.body, 4, "every substitution is counted on its surface");
  // Salted: not the dictionary-testable plain sha256, stable within one
  // export, different across exports.
  assert.notEqual(placeholderFor(LOW, context), sha(LOW));
  assert.equal(placeholderFor(PRI, context), placeholderFor(PRI, context));
  assert.notEqual(placeholderFor(PRI, context), placeholderFor(PRI, createExportScrubContext()));
  // Value-shaped: a registered secret value is scrubbed out of content.
  registerSecretValues(context, [HOOK]);
  assert.equal(scrubText(`the secret is ${HOOK} ok`, context).includes(HOOK), false);
  // Boundaries: padded base64 (a stored public key's shape) is not a
  // share token, and ordinary prose is untouched.
  const publicKey = Buffer.alloc(32, 7).toString("base64");
  assert.equal(publicKey.length, 44);
  assert.equal(scrubText(`key ${publicKey} end`, createExportScrubContext()).includes(publicKey), true);
  assert.equal(scrubText("plain release notes, nothing to hide", createExportScrubContext()), "plain release notes, nothing to hide");
});

test("room JSONL and HTML exports scrub token-shaped content like every other shape", async t => {
  const directory = mkdtempSync(join(tmpdir(), "export-scrub-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "m-tok", body: `leak ${PRI} and ${GX} and ${SHARE}` } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const response = await fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${ownerKey}` } });
    assert.equal(response.status, 200);
    return response.text();
  };
  for (const text of [await get("/api/rooms/commons/export"), await get("/api/rooms/commons/export?format=html")]) {
    assert.equal(text.includes(PRI), false);
    assert.equal(text.includes(GX), false);
    assert.equal(text.includes(SHARE), false);
    assert.match(text, /leak [0-9a-f]{64} and [0-9a-f]{64} and [0-9a-f]{64}/);
  }
});
