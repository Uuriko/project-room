// A009: attachment download. Pure validation/tracker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { validateAttachment, createDownloadTracker, AttachmentError } from "../server/attachments.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof AttachmentError && error.code === code);

test("validateAttachment accepts safe files, blocks dangerous ones", () => {
  const ok = validateAttachment({ filename: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf" });
  assert.equal(ok.extension, "pdf");
  assert.ok(Object.isFrozen(ok));
  throwsCode(() => validateAttachment({ filename: "evil.exe", sizeBytes: 10, mimeType: "application/x-msdownload" }),
    "blocked_extension");
  throwsCode(() => validateAttachment({ filename: "../secret", sizeBytes: 10, mimeType: "text/plain" }),
    "invalid_attachment");
  throwsCode(() => validateAttachment({ filename: "big.zip", sizeBytes: 10 ** 9, mimeType: "application/zip" }),
    "file_too_large");
});
test("tracker enforces per-message cap and download lifecycle", () => {
  const tracker = createDownloadTracker({ maxMessageBytes: 2000 });
  tracker.register("m1", "a1", { filename: "a.pdf", sizeBytes: 1000, mimeType: "application/pdf" });
  throwsCode(() => tracker.register("m1", "a2",
    { filename: "b.pdf", sizeBytes: 1500, mimeType: "application/pdf" }), "message_too_large");
  const downloading = tracker.markDownloading("a1");
  assert.equal(downloading.state, "downloading");
  const done = tracker.markDone("a1");
  assert.equal(done.state, "done");
  tracker.register("m2", "a3", { filename: "c.pdf", sizeBytes: 100, mimeType: "application/pdf" });
  const failed = tracker.markFailed("a3", "network timeout");
  assert.deepEqual([failed.state, failed.error], ["failed", "network timeout"]);
});
test("malformed inputs are refused", () => {
  throwsCode(() => validateAttachment({ filename: "", sizeBytes: 1, mimeType: "x" }), "invalid_attachment");
  const tracker = createDownloadTracker();
  throwsCode(() => tracker.markDone("ghost"), "invalid_attachment");
});
