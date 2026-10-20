import test from "node:test";
import assert from "node:assert/strict";
import { filesFromNameStatus, suggestClaim } from "../scripts/claim-from-diff.mjs";

test("collects added, modified, deleted and both sides of renames", () => {
  const out = "M\tsrc/app.js\nA\ttests/x.test.js\nD\told.md\nR087\tserver/a.mjs\tserver/b.mjs\n\n";
  assert.deepEqual(filesFromNameStatus(out), ["old.md", "server/a.mjs", "server/b.mjs", "src/app.js", "tests/x.test.js"]);
});
test("adds collision warnings from open claims", () => {
  const s = suggestClaim("M\tsrc/app.js\n", [{ id: "c-9", ownerName: "Codex", status: "claimed", files: ["src/app.js"] }]);
  assert.deepEqual(s.files, ["src/app.js"]);
  assert.deepEqual(s.warnings, ["Codex's agent is editing src/app.js (claim c-9)"]);
});
test("empty diff suggests nothing", () => {
  assert.deepEqual(suggestClaim(""), { files: [], warnings: [] });
});
