import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withAttachmentReferences, withAttachmentText } from "../client/shared-attachment-context.mjs";

import { createRoomClient } from "../client/room-assistant-client.mjs";

const file = (id, body = "hello", extra = {}) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { id, filename: "notes.txt", mediaType: "text/plain", byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), messageId: "m", state: "committed",
    encoding: "base64", data: bytes.toString("base64"), ...extra };
};
const inputs = [{ messageId: "m", memberId: "person", body: "Use my notes" }];

test("references include only selected committed files, preserve duplicate names, and exclude bytes", () => {
  const selected = withAttachmentReferences(inputs, [file("b"), file("a"), file("other", "secret", { messageId: "private" }), file("draft", "draft", { state: "staged" })]);
  assert.deepEqual(selected[0].attachments.map(x => x.id), ["a", "b"]);
  assert.equal(selected[0].attachments[0].data, undefined);
  assert.equal(inputs[0].attachments, undefined);
  const many = withAttachmentReferences(inputs, Array.from({ length: 70 }, (_, i) => file(String(i))));
  assert.equal(many[0].attachments.length, 64); assert.equal(many[0].omittedAttachmentCount, 6);
});

test("authorized text is verified and included without truncation", async () => {
  const f = file("a", "Résumé ✨"); let reads = 0;
  const result = await withAttachmentText(withAttachmentReferences(inputs, [f]), async id => { reads++; assert.equal(id, "a"); return f; });
  assert.equal(result[0].attachments[0].text, "Résumé ✨");
  assert.equal(result[0].attachments[0].contentStatus, "read"); assert.equal(reads, 1);
});

test("unsupported and oversized files do not download; total text budget is bounded", async () => {
  const files = [file("a", "pdf", { mediaType: "application/pdf" }), file("b", "x".repeat(16385)),
    ...Array.from({ length: 5 }, (_, i) => file(`c${i}`, "x".repeat(16384)))];
  const reads = [];
  const result = await withAttachmentText(withAttachmentReferences(inputs, files), async id => { reads.push(id); return files.find(x => x.id === id); });
  assert.equal(reads.length, 4);
  assert.deepEqual(result[0].attachments.filter(x => x.contentStatus === "not_read").map(x => x.reason), ["unsupported_format", "file_size_limit", "context_budget"]);
});

test("revocation, changed bytes and non-UTF8 are explicit unread states", async () => {
  for (const status of [403, 404, 410]) {
    const result = await withAttachmentText(withAttachmentReferences(inputs, [file("a")]), async () => { throw Object.assign(new Error("private diagnostic"), { status }); });
    assert.equal(result[0].attachments[0].reason, "unavailable");
    assert.ok(!JSON.stringify(result).includes("private diagnostic"));
  }
  const f = file("a");
  const changed = await withAttachmentText(withAttachmentReferences(inputs, [f]), async () => ({ ...f, data: Buffer.from("other").toString("base64") }));
  assert.equal(changed[0].attachments[0].reason, "changed_or_invalid");
  const binary = file("b", Buffer.from([255, 254]));
  const invalid = await withAttachmentText(withAttachmentReferences(inputs, [binary]), async () => binary);
  assert.equal(invalid[0].attachments[0].reason, "unsupported_encoding");
  await assert.rejects(withAttachmentText(withAttachmentReferences(inputs, [f]), async () => { throw Object.assign(new Error("network"), { status: 503 }); }), /network/);
});

test("the assistant follows selected-message file pages before moving to the next batch", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `message-${i}`);
  const calls = [];
  const client = createRoomClient({ origin: "https://example.invalid", roomId: "commons", fetchImpl: async url => {
    const query = new URL(url).searchParams;
    const batch = query.getAll("messageId");
    const cursor = query.get("cursor");
    calls.push([batch, cursor]);
    const hasMore = calls.length === 1;
    return Response.json({ contractVersion: 2, files: hasMore ? [] : [{ messageId: batch.at(-1) }],
      coverage: { kind: "selected-messages", messageIds: batch, complete: !hasMore },
      page: { hasMore, nextCursor: hasMore ? "second" : null } });
  } });
  assert.deepEqual(await client.files([...ids, ids[0]]), [{ messageId: ids[7] }, { messageId: ids[8] }]);
  assert.deepEqual(calls, [[ids.slice(0, 8), null], [ids.slice(0, 8), "second"], [[ids[8]], null]]);
});

test("legacy attachment inventory is read once and filtered to all selected inputs", async () => {
  let reads = 0;
  const client = createRoomClient({ origin: "https://example.invalid", roomId: "commons", fetchImpl: async () => {
    reads++;
    return Response.json({ files: [{ messageId: "8" }, { messageId: "unselected" }] });
  } });
  assert.deepEqual(await client.files([]), []);
  assert.deepEqual(await client.files(Array.from({ length: 9 }, (_, i) => String(i))), [{ messageId: "8" }]);
  assert.equal(reads, 1);
});

test("a stale attachment cursor restarts the selection and drops partial results", async () => {
  const cursors = [];
  const client = createRoomClient({ origin: "https://example.invalid", roomId: "commons", fetchImpl: async url => {
    cursors.push(new URL(url).searchParams.get("cursor"));
    if (cursors.length === 2) return Response.json({ error: { code: "attachment_cursor_reset" } }, { status: 409 });
    const partial = cursors.length === 1;
    return Response.json({ contractVersion: 2, files: [{ messageId: "m", id: partial ? "old" : "new" }],
      coverage: { kind: "selected-messages", messageIds: ["m"], complete: !partial },
      page: { hasMore: partial, nextCursor: partial ? "stale" : null } });
  } });
  assert.deepEqual(await client.files(["m"]), [{ messageId: "m", id: "new" }]);
  assert.deepEqual(cursors, [null, "stale", null]);
});
