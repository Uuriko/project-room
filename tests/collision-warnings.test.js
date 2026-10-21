import test from "node:test";
import assert from "node:assert/strict";
import { collisionWarnings, normalizePath } from "../server/collision-warnings.mjs";

const claims = [
  { id: "c-1", ownerId: "u-codex", ownerName: "Codex", status: "claimed", files: ["src/app.js"] },
  { id: "c-2", ownerId: "u-jill", ownerName: "Jill", status: "claimed", files: ["server/"] },
  { id: "c-3", ownerId: "u-old", ownerName: "Old", status: "done", files: ["README.md"] },
];

test("names the holder of an overlapping file", () => {
  const [w] = collisionWarnings(["./src/app.js"], claims);
  assert.equal(w.text, "Codex's agent is editing src/app.js (claim c-1)");
  assert.equal(w.caseOnly, false);
});
test("directory claims cover children", () => {
  assert.equal(collisionWarnings(["server/http.mjs"], claims)[0].claimId, "c-2");
});
test("case-only overlaps warn and say why", () => {
  const [w] = collisionWarnings(["SRC/app.js"], claims);
  assert.equal(w.caseOnly, true);
  assert.match(w.text, /macOS and Windows/);
});
test("closed claims and your own claims are ignored", () => {
  assert.deepEqual(collisionWarnings(["README.md"], claims), []);
  assert.deepEqual(collisionWarnings(["src/app.js"], claims, { self: "u-codex" }), []);
});
test("prefix that is not a directory does not match", () => {
  assert.deepEqual(collisionWarnings(["serverless.js", "src/app.json"], claims), []);
});
test("garbage input is tolerated", () => {
  assert.deepEqual(collisionWarnings(null, null), []);
  assert.equal(normalizePath("a\\b/../c"), "a/c");
});
