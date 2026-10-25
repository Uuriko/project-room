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
test("filenames separate path separators, controls, and invisible characters", () => {
  const meta = (filename) => validateAttachment({ filename, sizeBytes: 4, mimeType: "text/plain" });
  const refused = (filename, message) => assert.throws(() => meta(filename), error =>
    error instanceof AttachmentError && error.code === "invalid_attachment" && error.message === message);
  refused("a/b.txt", "filename must not contain path separators");
  refused("a\\b.txt", "filename must not contain path separators");
  refused("a/b\u0000.txt", "filename must not contain path separators");
  for (const filename of ["a\u0000b.txt", "a\nb.txt", "a\tb.txt", "a\u001bb.txt"]) {
    refused(filename, "filename must not contain control characters");
  }
  refused("invoice\u202Efdp.exe.txt", "filename must not contain bidirectional embedding, override or isolate characters (U+202A-202E, U+2066-2069)");
  refused("a\u2066b.txt", "filename must not contain bidirectional embedding, override or isolate characters (U+202A-202E, U+2066-2069)");
  for (const char of ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"]) {
    refused(`notes${char}.txt`, "filename must not contain zero-width characters");
  }
  refused("notes\u{E0000}.txt", "filename must not contain Unicode tag characters (U+E0000-E007F)");
  refused("notes\u{E007F}.txt", "filename must not contain Unicode tag characters (U+E0000-E007F)");
  assert.equal(meta("café.txt").filename, "café.txt");
  assert.equal(meta("İstanbul.txt").filename, "İstanbul.txt");
  assert.equal(meta("report.pdf:Zone.Identifier").extension, "pdf");
});

test("malformed inputs are refused", () => {
  throwsCode(() => validateAttachment({ filename: "", sizeBytes: 1, mimeType: "x" }), "invalid_attachment");
  const tracker = createDownloadTracker();
  throwsCode(() => tracker.markDone("ghost"), "invalid_attachment");
});

test("validateAttachment reads the extension the way Windows saves the file (trailing dots and spaces)", () => {
  for (const filename of ["evil.exe.", "evil.exe ", "evil.EXE. . ", "evil.exe..."]) {
    throwsCode(() => validateAttachment({ filename, sizeBytes: 10, mimeType: "text/plain" }), "blocked_extension");
  }
  assert.throws(() => validateAttachment({ filename: "evil.bat\t", sizeBytes: 10, mimeType: "text/plain" }), error =>
    error instanceof AttachmentError && error.code === "invalid_attachment" && error.message === "filename must not contain control characters");
  assert.equal(validateAttachment({ filename: "notes.txt.", sizeBytes: 1, mimeType: "text/plain" }).extension, "txt");
  assert.equal(validateAttachment({ filename: "plain", sizeBytes: 1, mimeType: "text/plain" }).extension, "");
});

test("QA200-REG-14: benign trailing dots/spaces are allowed with the normalized extension", () => {
  // Regression guard for 0804d1525: the normalization must not turn a
  // benign trailing dot/space into a rejection, and the reported
  // extension must be the normalized one.
  assert.equal(validateAttachment({ filename: "report.pdf ", sizeBytes: 1, mimeType: "application/pdf" }).extension, "pdf");
  assert.equal(validateAttachment({ filename: "report.pdf.", sizeBytes: 1, mimeType: "application/pdf" }).extension, "pdf");
  assert.equal(validateAttachment({ filename: "archive.tar.gz ", sizeBytes: 1, mimeType: "application/gzip" }).extension, "gz");
  assert.equal(validateAttachment({ filename: "noext ", sizeBytes: 1, mimeType: "text/plain" }).extension, "");
  // Non-breaking space is whitespace too: a blocked extension behind one
  // must still be caught the way Windows saves it.
  throwsCode(() => validateAttachment({ filename: "evil.exe ", sizeBytes: 1, mimeType: "text/plain" }), "blocked_extension");
});
