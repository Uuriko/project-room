// Task 42 (TASKS.md): structured audit export of the direct channel-send
// journal. The journal is append-only and write-only through the HTTP path;
// the owner needs a CSV/JSON review of exactly what the room sent, when,
// through which channel — following the publicDirectSend contract (no body
// content, no body hashes, no secrets).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { toJsonExport, ExportError } from "../server/csv-export.mjs";
import { recordDirectSend, completeDirectSend, listDirectSends, exportDirectSends,
  directSendExportColumns, directSendExportRow } from "../server/inbox-outbox.mjs";

const bodyHash = body => createHash("sha256").update(body, "utf8").digest("hex");
const throwsSend = fn => assert.throws(fn, error => error.code === "invalid_direct_send");
const throwsExport = fn => assert.throws(fn, error => error instanceof ExportError && error.code === "invalid_export");

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return db;
}
const seed = (db, { accountId, id = randomUUID(), channel = "telegram", to = "123456", subject = "Hello",
  body = "never-exported body text", threadId = null, at = 1000 }) =>
  recordDirectSend(db, { id, accountId, channel, to, subject, bodyHash: bodyHash(body), threadId, at });

test("an empty journal lists nothing and exports header-only CSV", t => {
  const db = setup(t);
  assert.deepEqual(listDirectSends(db, "acc-1"), { sends: [], nextCursor: null });
  const csv = exportDirectSends(db, "acc-1", { at: 1726617600000 });
  assert.equal(csv.format, "csv");
  assert.equal(csv.filename, "direct-channel-sends-2024-09-18.csv");
  assert.equal(csv.text, "Send ID,Channel,Recipient,Subject,Thread ID,Status,Provider ID,Error,Created (UTC),Updated (UTC)\r\n");
  const json = exportDirectSends(db, "acc-1", { format: "json", at: 1726617600000 });
  assert.equal(json.format, "json");
  assert.equal(json.filename, "direct-channel-sends-2024-09-18.json");
  assert.deepEqual(JSON.parse(json.text), {
    export: "direct-channel-sends", generatedAt: "2024-09-18T00:00:00.000Z", count: 0,
    columns: directSendExportColumns().map(c => ({ key: c.key, header: c.header })), rows: []
  });
});

test("listing is newest-first and strictly account-scoped", t => {
  const db = setup(t);
  seed(db, { accountId: "acc-1", subject: "first", at: 1000 });
  seed(db, { accountId: "acc-1", subject: "second", at: 2000 });
  seed(db, { accountId: "acc-1", subject: "third", at: 3000 });
  seed(db, { accountId: "acc-2", subject: "other account", at: 4000 });
  const page = listDirectSends(db, "acc-1");
  assert.deepEqual(page.sends.map(s => s.subject), ["third", "second", "first"]);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(listDirectSends(db, "acc-2").sends.map(s => s.subject), ["other account"]);
  // Public shape only: recipient, subject, channel, status — never body content or hashes.
  for (const send of page.sends) {
    assert.deepEqual(Object.keys(send).sort(),
      ["channel", "createdAt", "errorCode", "id", "providerId", "status", "subject", "threadId", "to", "updatedAt"]);
  }
});

test("status filter and keyset pagination walk the journal", t => {
  const db = setup(t);
  const a = seed(db, { accountId: "acc-1", subject: "a", at: 1000 });
  const b = seed(db, { accountId: "acc-1", subject: "b", at: 2000 });
  const c = seed(db, { accountId: "acc-1", subject: "c", at: 3000 });
  completeDirectSend(db, b.id, { status: "sent", providerId: "tg-42", at: 2100 });
  completeDirectSend(db, c.id, { status: "failed", errorCode: "channel_send_failed", at: 3100 });
  assert.deepEqual(listDirectSends(db, "acc-1", { status: "pending" }).sends.map(s => s.id), [a.id]);
  assert.deepEqual(listDirectSends(db, "acc-1", { status: "sent" }).sends.map(s => s.id), [b.id]);
  assert.deepEqual(listDirectSends(db, "acc-1", { status: "failed" }).sends.map(s => s.id), [c.id]);
  const first = listDirectSends(db, "acc-1", { limit: 2 });
  assert.deepEqual(first.sends.map(s => s.subject), ["c", "b"]);
  assert.ok(first.nextCursor);
  const second = listDirectSends(db, "acc-1", { limit: 2, before: first.nextCursor });
  assert.deepEqual(second.sends.map(s => s.subject), ["a"]);
  assert.equal(second.nextCursor, null);
  const failed = listDirectSends(db, "acc-1", { status: "failed" }).sends[0];
  assert.equal(failed.errorCode, "channel_send_failed");
  assert.equal(listDirectSends(db, "acc-1", { status: "sent" }).sends[0].providerId, "tg-42");
});

test("pagination cursor follows time order even when id order disagrees", t => {
  const db = setup(t);
  // Ids sort z > m > a lexicographically while created_at sorts the opposite.
  seed(db, { accountId: "acc-1", id: "id-zzz", subject: "oldest", at: 1000 });
  seed(db, { accountId: "acc-1", id: "id-mmm", subject: "middle", at: 2000 });
  seed(db, { accountId: "acc-1", id: "id-aaa", subject: "newest", at: 3000 });
  const first = listDirectSends(db, "acc-1", { limit: 1 });
  assert.deepEqual(first.sends.map(s => s.subject), ["newest"]);
  assert.ok(typeof first.nextCursor === "string" && first.nextCursor.length > 0);
  assert.notEqual(first.nextCursor, first.sends[0].id);
  const second = listDirectSends(db, "acc-1", { limit: 1, before: first.nextCursor });
  assert.deepEqual(second.sends.map(s => s.subject), ["middle"]);
  const third = listDirectSends(db, "acc-1", { limit: 1, before: second.nextCursor });
  assert.deepEqual(third.sends.map(s => s.subject), ["oldest"]);
  assert.equal(third.nextCursor, null);
  // Same created_at ties break on id, and the cursor still walks them in order.
  const db2 = setup(t);
  seed(db2, { accountId: "acc-1", id: "tie-b", subject: "tie second", at: 5000 });
  seed(db2, { accountId: "acc-1", id: "tie-a", subject: "tie first", at: 5000 });
  const p1 = listDirectSends(db2, "acc-1", { limit: 1 });
  assert.deepEqual(p1.sends.map(s => s.subject), ["tie second"]);
  const p2 = listDirectSends(db2, "acc-1", { limit: 1, before: p1.nextCursor });
  assert.deepEqual(p2.sends.map(s => s.subject), ["tie first"]);
  assert.equal(p2.nextCursor, null);
  // Malformed cursors are refused.
  throwsSend(() => listDirectSends(db, "acc-1", { before: "not-a-cursor" }));
  throwsSend(() => listDirectSends(db, "acc-1", { before: "12:__bad__" }));
});

test("malformed listing and export arguments are refused", t => {
  const db = setup(t);
  throwsSend(() => listDirectSends(db, ""));
  throwsSend(() => listDirectSends(db, "acc-1", { limit: 0 }));
  throwsSend(() => listDirectSends(db, "acc-1", { limit: 1001 }));
  throwsSend(() => listDirectSends(db, "acc-1", { status: "unknown" }));
  throwsSend(() => listDirectSends(db, "acc-1", { before: "" }));
  throwsSend(() => exportDirectSends(db, "", { at: 1 }));
  throwsSend(() => exportDirectSends(db, "acc-1", { format: "xml", at: 1 }));
  throwsSend(() => exportDirectSends(db, "acc-1", { status: "unknown", at: 1 }));
  throwsSend(() => exportDirectSends(db, "acc-1", { at: -1 }));
});

test("csv export: exact rows, ISO timestamps, RFC 4180 quoting, no body content", t => {
  const db = setup(t);
  const hash = bodyHash("never-exported body text");
  const tricky = seed(db, { accountId: "acc-1", to: "987654321", subject: 'Re: "launch", tomorrow',
    channel: "telegram", at: 1726617600000 });
  completeDirectSend(db, tricky.id, { status: "sent", providerId: "tg-7", at: 1726617660000 });
  const gmail = seed(db, { accountId: "acc-1", channel: "gmail", to: "maya@example.test", subject: "Plain",
    at: 1726617720000 });
  completeDirectSend(db, gmail.id, { status: "failed", errorCode: "gmail_send_failed", at: 1726617780000 });
  const { text } = exportDirectSends(db, "acc-1", { at: 1726617800000 });
  assert.equal(text,
    "Send ID,Channel,Recipient,Subject,Thread ID,Status,Provider ID,Error,Created (UTC),Updated (UTC)\r\n" +
    `${tricky.id},telegram,987654321,"Re: ""launch"", tomorrow",,sent,tg-7,,2024-09-18T00:00:00.000Z,2024-09-18T00:01:00.000Z\r\n` +
    `${gmail.id},gmail,maya@example.test,Plain,,failed,,gmail_send_failed,2024-09-18T00:02:00.000Z,2024-09-18T00:03:00.000Z\r\n`);
  assert.ok(!text.includes("never-exported body text"), "message body must never appear in the export");
  assert.ok(!text.includes(hash), "body hash must not appear in the export");
});

test("json export carries exactly the same rows as csv", t => {
  const db = setup(t);
  const send = seed(db, { accountId: "acc-1", at: 1726617600000 });
  completeDirectSend(db, send.id, { status: "sent", providerId: "tg-9", at: 1726617660000 });
  const json = exportDirectSends(db, "acc-1", { format: "json", at: 1726617800000 });
  const doc = JSON.parse(json.text);
  assert.equal(doc.export, "direct-channel-sends");
  assert.equal(doc.generatedAt, "2024-09-18T00:03:20.000Z");
  assert.equal(doc.count, 1);
  const settled = db.prepare("SELECT * FROM direct_channel_sends WHERE id=?").get(send.id);
  assert.deepEqual(doc.rows, [directSendExportRow(settled)]);
  assert.deepEqual(doc.rows[0], {
    id: send.id, channel: "telegram", to: "123456", subject: "Hello", threadId: null,
    status: "sent", providerId: "tg-9", errorCode: null,
    createdAt: "2024-09-18T00:00:00.000Z", updatedAt: "2024-09-18T00:01:00.000Z"
  });
  const csvRows = exportDirectSends(db, "acc-1", { at: 1726617800000 }).text.split("\r\n").slice(1, 2);
  assert.ok(csvRows[0].startsWith(`${send.id},telegram,123456,Hello,,sent,tg-9,,`));
});

test("toJsonExport projects rows to the column keys and refuses malformed inputs", () => {
  const doc = JSON.parse(toJsonExport({ name: "audit", generatedAt: "2024-01-01T00:00:00.000Z",
    columns: [{ key: "a", header: "A" }, { key: "b", header: "B" }],
    rows: [{ a: 1, b: 2, extra: "dropped" }, { a: 3 }] }));
  assert.deepEqual(doc.rows, [{ a: 1, b: 2 }, { a: 3, b: null }]);
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.columns, [{ key: "a", header: "A" }, { key: "b", header: "B" }]);
  throwsExport(() => toJsonExport({ name: "", generatedAt: "x", columns: [{ key: "a", header: "A" }], rows: [] }));
  throwsExport(() => toJsonExport({ name: "n", generatedAt: "", columns: [{ key: "a", header: "A" }], rows: [] }));
  throwsExport(() => toJsonExport({ name: "n", generatedAt: "x", columns: [], rows: [] }));
  throwsExport(() => toJsonExport({ name: "n", generatedAt: "x", columns: [{ key: "a", header: "A" }], rows: [null] }));
});

test("status-filtered export contains only that state", t => {
  const db = setup(t);
  const a = seed(db, { accountId: "acc-1", subject: "pending one", at: 1000 });
  const b = seed(db, { accountId: "acc-1", subject: "sent one", at: 2000 });
  completeDirectSend(db, b.id, { status: "sent", providerId: "tg-1", at: 2100 });
  const { text } = exportDirectSends(db, "acc-1", { status: "sent", at: 3000 });
  assert.ok(text.includes(a.id) === false);
  assert.ok(text.includes(b.id));
});
