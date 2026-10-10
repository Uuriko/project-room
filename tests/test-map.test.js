// TST-15: the test map links each test file to modules and one lane, and the
// committed doc matches the generator.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMap, laneFor, namesOverlap, referencedModules, HUBS, SCHEMA } from "../scripts/test-map.mjs";

test("lanes follow module paths, specific rules before general ones", () => {
  assert.equal(laneFor("server/work-claim-routes.mjs"), "work-claims");
  assert.equal(laneFor("server/mcp-hosted.mjs"), "mcp");
  assert.equal(laneFor("server/bounty-escrow.mjs"), "economy-shelved");
  assert.equal(laneFor("cloudflare/storage.mjs"), "platform");
  assert.equal(laneFor("src/app.js"), "ui");
  assert.equal(laneFor("scripts/check.mjs"), "tooling");
  assert.equal(laneFor("server/some-new-thing.mjs"), "core");
});

test("names overlap on a leading word or a shared 4+ letter stem", () => {
  assert.ok(namesOverlap("guest-join.test.js", "server/guest-invites.mjs"));
  assert.ok(namesOverlap("my-accounts.test.js", "server/account-store.mjs"));
  assert.ok(!namesOverlap("typing.test.js", "server/retention.mjs"));
});

test("references come from import specifiers and quoted source paths that exist", () => {
  const text = `import { a } from "../server/store.mjs";\nconst b = await import("../cloudflare/storage.mjs");\nrun("scripts/check.mjs");\nimport x from "node:fs";\nconst y = "server/does-not-exist.mjs";`;
  assert.deepEqual(referencedModules(`${process.cwd()}/tests/fake.test.js`, text), ["cloudflare/storage.mjs", "scripts/check.mjs", "server/store.mjs"]);
});

test("every test file gets one row and hub modules never become primary", () => {
  const map = buildMap();
  assert.equal(map.schema, SCHEMA);
  assert.equal(map.rows.length, map.tests);
  assert.equal(Object.values(map.lanes).reduce((a, b) => a + b, 0), map.tests);
  for (const row of map.rows) {
    assert.ok(row.lane, row.test);
    if (row.primary) assert.ok(!HUBS.has(row.primary), `${row.test} primary is a hub`);
    if (row.via === "none") assert.equal(row.lane, "unassigned");
  }
  const self = map.rows.find(r => r.test === "tests/test-map.test.js");
  assert.equal(self.primary, "scripts/test-map.mjs");
  assert.equal(self.lane, "tooling");
});
