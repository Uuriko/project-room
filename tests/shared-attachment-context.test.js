import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withAttachmentReferences, withAttachmentText } from "../client/shared-attachment-context.mjs";

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
