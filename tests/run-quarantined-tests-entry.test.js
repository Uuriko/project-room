// Worker-46 fail-first: run-quarantined-tests.mjs input handling.
// - bare string entries are accepted as "file > test name" specs (the doc
//   promises a bare-file entry runs the whole file; a plain string entry used
//   to be reported as "entry has no test file")
// - describeExit names a signal kill instead of printing "exit null"
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuarantineEntry, describeExit } from "../scripts/run-quarantined-tests.mjs";

test("parseQuarantineEntry accepts a bare string entry as a file spec", () => {
  assert.deepEqual(parseQuarantineEntry("tests/foo.test.js"), { file: "tests/foo.test.js", name: null });
});

test("parseQuarantineEntry accepts a bare string entry with a test name", () => {
  assert.deepEqual(
    parseQuarantineEntry("tests/foo.test.js > some test"),
    { file: "tests/foo.test.js", name: "some test" },
  );
});

test("parseQuarantineEntry keeps the object-entry shape", () => {
  assert.deepEqual(
    parseQuarantineEntry({ test: "scripts/x.mjs > does y" }),
    { file: "scripts/x.mjs", name: "does y" },
  );
});

test("parseQuarantineEntry returns null for entries with no file", () => {
  assert.equal(parseQuarantineEntry({}), null);
  assert.equal(parseQuarantineEntry({ test: "" }), null);
  assert.equal(parseQuarantineEntry(null), null);
  assert.equal(parseQuarantineEntry(""), null);
});

test("describeExit reports an exit code", () => {
  assert.equal(describeExit({ status: 1, signal: null }), "exit 1");
});

test("describeExit reports a signal instead of 'exit null'", () => {
  assert.equal(describeExit({ status: null, signal: "SIGKILL" }), "signal SIGKILL");
  assert.equal(describeExit({ status: null, signal: null }), "signal unknown");
});
