import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLibrary, selectEntries } from "../scripts/source-library.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("../docs/source-library.json", import.meta.url)));
test("pinned candidates remain actionable without pretending they are adopted", () => {
  const data = fixture(); assert.deepEqual(validateLibrary(data), []);
  assert.equal(selectEntries(data, "next").length, 2);
  assert.equal(selectEntries(data, "list", "adopted").length, 0);
  assert.equal(selectEntries(data, "show", "buzz-canvas-save").upstream.revision.length, 40);
  assert.throws(() => selectEntries(data, "show", "missing"), /Unknown/);
});
test("adoption cannot lose integration, notices, provenance or next action", () => {
  const data = fixture(); data.entries[0].status = "adopted";
  data.entries[0].upstream.revision = "main";
  data.entries[0].nextAction = "";
  assert.match(validateLibrary(data).join(";"), /adopted requires/);
  assert.match(validateLibrary(data).join(";"), /immutable/);
  assert.match(validateLibrary(data).join(";"), /nextAction/);
});
test("duplicate ids and missing licensing are rejected", () => {
  const data = fixture(); data.entries.push(structuredClone(data.entries[0]));
  delete data.entries[0].license;
  assert.match(validateLibrary(data).join(";"), /duplicate id/);
  assert.match(validateLibrary(data).join(";"), /license evidence/);
});
test("local integration checks reject missing files and escaping symlinks", t => {
  const base = mkdtempSync(join(tmpdir(), "source-library-"));
  const outside = mkdtempSync(join(tmpdir(), "source-outside-"));
  t.after(() => { rmSync(base, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(outside, "code.mjs"), "// outside");
  symlinkSync(join(outside, "code.mjs"), join(base, "link.mjs"));
  const data = fixture(); data.entries[0].localPaths = ["missing.mjs", "../outside", "link.mjs"];
  const errors = validateLibrary(data, base).join(";");
  assert.match(errors, /missing local path/); assert.match(errors, /escapes repository/);
});
