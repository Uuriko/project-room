// K027: file version history. Pure tracker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createVersions, VersionError } from "../server/file-versions.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof VersionError && error.code === code);

test("record/history/get/diffMeta lifecycle", () => {
  const versions = createVersions();
  const v1 = versions.record({ fileId: "f1", contentHash: "abc", sizeBytes: 100, authorId: "ada" });
  assert.equal(v1.version, 1);
  assert.ok(Object.isFrozen(v1));
  const v2 = versions.record({ fileId: "f1", contentHash: "def", sizeBytes: 150, authorId: "bob", note: "bigger" });
  assert.equal(v2.version, 2);
  const history = versions.history("f1");
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2); // newest first
  assert.equal(versions.get("f1", 1).contentHash, "abc");
  const diff = versions.diffMeta("f1", { from: 1, to: 2 });
  assert.equal(diff.hashChanged, true);
  assert.equal(diff.sizeDelta, 50);
});
test("malformed inputs are refused", () => {
  const versions = createVersions();
  throwsCode(() => versions.record({ fileId: "", contentHash: "x", sizeBytes: 1, authorId: "a" }), "invalid_version");
  throwsCode(() => versions.get("f1", 5), "invalid_version");
});
