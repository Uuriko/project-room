// K015: shared files. Pure metadata tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createFiles, FileError, PREVIEWABLE } from "../server/room-files.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof FileError && error.code === code);

test("register/listByRoom/get lifecycle", () => {
  const files = createFiles();
  const f1 = files.register({ roomId: "r1", filename: "doc.pdf", mimeType: "application/pdf",
    sizeBytes: 1024, uploaderId: "ada" });
  assert.ok(f1.fileId.startsWith("file-"));
  assert.equal(f1.previewable, true);
  assert.ok(Object.isFrozen(f1));
  const f2 = files.register({ roomId: "r1", filename: "data.bin", mimeType: "application/octet-stream",
    sizeBytes: 2048, uploaderId: "bob" });
  assert.equal(f2.previewable, false);
  const list = files.listByRoom("r1");
  assert.equal(list.length, 2);
  assert.equal(list[0].fileId, f2.fileId); // newest first
  assert.equal(files.get(f1.fileId).filename, "doc.pdf");
  assert.ok(PREVIEWABLE.includes("image/png"));
});
test("malformed inputs are refused", () => {
  const files = createFiles();
  throwsCode(() => files.register({ roomId: "r", filename: "", mimeType: "text/plain",
    sizeBytes: 1, uploaderId: "a" }), "invalid_file");
  throwsCode(() => files.get("ghost"), "invalid_file");
});
