import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const room = resolve(process.env.ROOM_SCRIPT || "scripts/room");
const locate = name => spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).stdout.trim();
function environment(t, hash) {
  const root = mkdtempSync(join(tmpdir(), "room-portable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["bash", "jq", "awk", "sed", "head", "cut", ...(hash ? [hash] : [])]) {
    const command = locate(name); assert.ok(command, `test prerequisite: ${name}`);
    symlinkSync(command, join(root, name));
  }
  return { root, run: args => spawnSync(room, args, { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: root } }) };
}

test("offline clock correction works without gh on PATH", t => {
  const f = environment(t);
  const result = f.run(["_clock", "--op", "1790207382", "--date", "Wed, 23 Sep 2026 23:49:42 GMT"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1790207382");
});

for (const hash of ["sha256sum", "shasum"]) {
  test(`local query verifies integrity with only ${hash}, and refuses changed content`, { skip: !locate(hash) && `${hash} is unavailable on this host` }, t => {
    const f = environment(t, hash), file = join(f.root, "state.md");
    // No gh on PATH: an offline query must neither require nor invoke it.
    const row = "RC-2026-10-27-100 | quill | working | 2026-10-28T00:00:00Z | src/a.js";
    const digest = createHash("sha256").update(row + "\n").digest("hex");
    const body = `<!-- integrity: sha256=${digest} -->\n## open\n${row}\n`;
    writeFileSync(file, body);
    const good = f.run(["query", "--state", file]);
    assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /RC-2026-10-27-100/);
    writeFileSync(file, body.replace("src/a.js", "src/b.js"));
    const bad = f.run(["query", "--state", file]);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /integrity check failed/);
  });
}

test("local query refuses when no SHA-256 implementation is available", t => {
  const f = environment(t), file = join(f.root, "state.md");
  const gh = join(f.root, "gh"); writeFileSync(gh, "#!/bin/sh\nexit 99\n"); chmodSync(gh, 0o700);
  writeFileSync(file, "## open\n");
  const result = f.run(["query", "--state", file]);
  assert.equal(result.status, 1); assert.match(result.stderr, /missing dependency: sha256sum or shasum/);
});

test("live query still requires the GitHub transport", t => {
  const f = environment(t);
  const result = f.run(["query", "--live"]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /missing dependency: gh/);
});
