// Worker-46 fail-first: browser-ci.mjs must reject a malformed --shard value
// with a usage line on stderr and exit 2 — never an uncaught parseShard stack.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/browser-ci.mjs`;

const NO_STACK = /^\s*at\s/m;

for (const bad of ["--shard=5/4", "--shard=0/4", "--shard=abc", "--shard=1/4/2"]) {
  test(`browser-ci.mjs ${bad}: usage error exits 2 without a stack trace`, () => {
    const r = spawnSync(process.execPath, [script, bad], {
      encoding: "utf8", timeout: 30000, cwd: root,
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  });
}
