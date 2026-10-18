// Registry closure for Cloudflare checks (SYSTEMIC-MAP F-27): every
// `cloudflare/*.check.mjs` on disk must be named in one of the run scripts
// in this directory's package.json (`test` or `test:browser`) — the scripts
// the CI cloudflare job runs (`npm test` + `npm run test:browser` in
// .github/workflows/test.yml). Before this guard, code-drops, room-export
// and restore-fk-order (the #3324 KV-restore FK-order regression guard)
// existed on disk but were named nowhere, so they executed nowhere: a
// check that never runs spends trust instead of buying coverage.
// This file is itself a *.check.mjs named in `test`, so the closure covers
// it too; a future check added to disk without being wired fails here, and
// a wired name with no file on disk (stale or mistyped) fails here too.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

test("every cloudflare/*.check.mjs on disk is wired into cloudflare/package.json run scripts, with no stale or duplicate entries", () => {
  const onDisk = readdirSync(dir).filter(name => name.endsWith(".check.mjs")).sort();
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const runScripts = [pkg.scripts?.test ?? "", pkg.scripts?.["test:browser"] ?? ""].join(" ");
  const wired = [...runScripts.matchAll(/[\w.-]+\.check\.mjs/g)].map(match => match[0]);

  const unwired = onDisk.filter(name => !wired.includes(name));
  assert.deepEqual(unwired, [],
    `cloudflare checks on disk but named in neither "test" nor "test:browser" in cloudflare/package.json (they would run nowhere): ${unwired.join(", ")}`);
  const stale = wired.filter(name => !onDisk.includes(name));
  assert.deepEqual(stale, [],
    `cloudflare/package.json names checks that do not exist on disk: ${stale.join(", ")}`);
  const duplicates = [...new Set(wired.filter((name, index) => wired.indexOf(name) !== index))];
  assert.deepEqual(duplicates, [],
    `cloudflare/package.json names these checks more than once across "test"/"test:browser": ${duplicates.join(", ")}`);
});
