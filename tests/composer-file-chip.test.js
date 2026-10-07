import test from "node:test";
import assert from "node:assert/strict";
import { fileChipLabel, attachmentFromBytes } from "../src/composer-files.js";

test("fileChipLabel shows the trimmed filename", () => {
  assert.equal(fileChipLabel("report.pdf"), "report.pdf");
  assert.equal(fileChipLabel("  spaced name .png  "), "spaced name .png");
});

test("fileChipLabel falls back to the shared default for blank or missing names", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(fileChipLabel(value), "file");
  }
});

test("the chip label matches the filename the upload stores for the same input", () => {
  // attachmentFromBytes and the chip must agree on the fallback, or the chip
  // shows one name while the room stores another.
  for (const filename of ["", "   ", "notes.txt"]) {
    const stored = attachmentFromBytes({ id: "a", filename, bytes: new Uint8Array([1]) }).filename;
    assert.equal(fileChipLabel(filename), stored);
  }
});
