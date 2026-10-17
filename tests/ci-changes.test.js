import test from "node:test";
import assert from "node:assert/strict";
import { classifyChanges } from "../scripts/ci-changes.mjs";

test("coverage runs when measured source modules change", () => {
  assert.equal(classifyChanges(["server/store.mjs"]).coverage, true);
  assert.equal(classifyChanges(["src/board-ui.js"]).coverage, true);
  assert.equal(classifyChanges(["machine/test/machine.test.mjs"]).coverage, true);
});

test("coverage runs when test files change (they feed the measurement)", () => {
  assert.equal(classifyChanges(["tests/store.test.js"]).coverage, true);
});

test("coverage runs when the gate's own config, script, classifier, or workflow changes", () => {
  assert.equal(classifyChanges(["coverage-thresholds.json"]).coverage, true);
  assert.equal(classifyChanges(["scripts/coverage-thresholds.mjs"]).coverage, true);
  assert.equal(classifyChanges(["scripts/ci-changes.mjs"]).coverage, true);
  assert.equal(classifyChanges([".github/workflows/test.yml"]).coverage, true);
});

test("coverage runs when a new test-discoverable script is added", () => {
  // node --test discovers **/{test,test/**/*,test-*,*[._-]test}: a new
  // scripts/*test* file executes and can move module coverage.
  assert.equal(classifyChanges(["scripts/load-test.mjs"]).coverage, true);
  assert.equal(classifyChanges(["scripts/check-smoke-test.mjs"]).coverage, true);
});

test("coverage runs when the resolution and entry-point layer changes", () => {
  // Bug sweep lane 14 F2 (#3901): package.json can carry dependency-version
  // changes, `imports` subpath remaps, and engines changes; the lockfile
  // pins what actually resolves; server.mjs is the root entry point the
  // suites spawn. All three sat outside every measured prefix, so a diff
  // touching only one of them skipped the ratchet entirely.
  assert.equal(classifyChanges(["package.json"]).coverage, true);
  assert.equal(classifyChanges(["package-lock.json"]).coverage, true);
  assert.equal(classifyChanges(["server.mjs"]).coverage, true);
});

test("coverage runs when a scripts helper the tests import changes", () => {
  // Non-test-discoverable scripts/*.mjs helpers execute inside the root
  // suite through test imports (the acceptance fixture drives the store
  // through the invariant/acceptance scenarios). Reachability through the
  // test-import closure, not the filename, decides.
  assert.equal(classifyChanges(["scripts/acceptance-fixture.mjs"]).coverage, true);
  assert.equal(classifyChanges(["scripts/email-contract-fixture.mjs"]).coverage, true);
});

test("coverage skips when the diff cannot move module line coverage", () => {
  assert.equal(classifyChanges(["docs/INDEX.md"]).coverage, false);
  assert.equal(classifyChanges(["scripts/deploy-prod.mjs"]).coverage, false);
  assert.equal(classifyChanges(["README.md", "docs/ROOM-API.md"]).coverage, false);
  assert.equal(classifyChanges([".github/workflows/qa2-agent-eval.yml"]).coverage, false);
});

test("coverage classification does not disturb the browser/eval outputs", () => {
  const docsOnly = classifyChanges(["docs/INDEX.md"]);
  assert.equal(docsOnly.browser, false);
  assert.equal(docsOnly.eval, false);
  const serverOnly = classifyChanges(["server/store.mjs"]);
  assert.equal(serverOnly.eval, true);
});

test("browser runs when server code changes (the checks create the real server)", () => {
  // Nearly every browser check imports createRoomServer from
  // server/http.mjs, and a few spawn server.mjs; a server-only PR must not
  // skip the suite that runs against that server.
  assert.equal(classifyChanges(["server/http.mjs"]).browser, true);
  assert.equal(classifyChanges(["server/store.mjs"]).browser, true);
  assert.equal(classifyChanges(["server/routes/table.mjs"]).browser, true);
  assert.equal(classifyChanges(["server.mjs"]).browser, true);
});

test("browser runs when a shared browser-check helper changes", () => {
  // These helpers are imported by suite checks but are not themselves
  // named in package.json's test:browser script.
  assert.equal(classifyChanges(["scripts/acceptance-fixture.mjs"]).browser, true);
  assert.equal(classifyChanges(["scripts/auth-signin.mjs"]).browser, true);
  assert.equal(classifyChanges(["scripts/room-chrome.mjs"]).browser, true);
  assert.equal(classifyChanges(["scripts/helpers/google-oauth-fixture.mjs"]).browser, true);
  // server/ modules the checks import (transitively, via the server).
  assert.equal(classifyChanges(["server/room-entry.mjs"]).browser, true);
});

test("browser still skips when the diff cannot affect the checks", () => {
  assert.equal(classifyChanges(["docs/INDEX.md"]).browser, false);
  assert.equal(classifyChanges(["scripts/deploy-recovery.mjs"]).browser, false);
  assert.equal(classifyChanges(["machine/test/machine.test.mjs"]).browser, false);
});
