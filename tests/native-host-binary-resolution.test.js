import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = new URL("../scripts/native-host-request-run.mjs", import.meta.url).pathname;

// A loopback fixture is enough: every assertion here is about resolving and
// checking the host binary, which happens before any host process is started.
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-native-binary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = join(directory, "fixture.json");
  writeFileSync(metadata, JSON.stringify({
    origin: "http://127.0.0.1:1", directory,
    participants: [{ memberId: "reviewer", configDirectory: join(directory, "c"), attentionDirectory: join(directory, "a") }]
  }));
  return { directory, metadata, output: join(directory, "evidence.json") };
}

const run = (args, env = {}) =>
  spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, ...env } });

test("a missing host binary fails with the variable to set, not with spawn noise", t => {
  const { metadata, output } = workspace(t);
  const missing = join(tmpdir(), "definitely-not-a-host-binary-xyz");
  const result = run(["claude", metadata, "review", output], { ROOM_CLAUDE_BINARY: missing });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host binary not found/);
  assert.match(result.stderr, /ROOM_CLAUDE_BINARY/, "the error names the variable that fixes it");
  assert.ok(result.stderr.includes(missing), "and the path it actually looked at");
});

test("a failed run leaves no reserved evidence behind, so the retry is not blocked", t => {
  const { metadata, output } = workspace(t);
  const result = run(["claude", metadata, "review", output], { ROOM_CLAUDE_BINARY: join(tmpdir(), "nope-xyz") });
  assert.equal(result.status, 1);
  // Reserving evidence and then failing used to leave the file in place, and the
  // next attempt died on EEXIST instead of running.
  assert.equal(existsSync(output), false, "the reserved evidence file was released");
});

test("existing evidence still refuses first, before the binary is considered", t => {
  const { metadata, output } = workspace(t);
  writeFileSync(output, "Original evidence");
  const result = run(["claude", metadata, "review", output], { ROOM_CLAUDE_BINARY: join(tmpdir(), "nope-xyz") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/, "reservation is still the first gate");
  assert.doesNotMatch(result.stderr, /host binary not found/);
  assert.equal(readFileSync(output, "utf8"), "Original evidence", "and existing evidence is untouched");
});

test("both hosts are overridable", t => {
  for (const [host, variable] of [["claude", "ROOM_CLAUDE_BINARY"], ["codex", "ROOM_CODEX_BINARY"]]) {
    const { metadata, output } = workspace(t);
    const result = run([host, metadata, "review", output], { [variable]: join(tmpdir(), `nope-${host}`) });
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, new RegExp(variable), host);
  }
});

test("the default claude path follows the current user, not one hardcoded home", t => {
  const { directory, metadata, output } = workspace(t);
  const home = join(directory, "fakehome");
  // os.homedir() reads HOME on POSIX, so this proves the default is derived
  // rather than a literal someone's machine happens to satisfy.
  const result = run(["claude", metadata, "review", output], { HOME: home, ROOM_CLAUDE_BINARY: "" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(join(home, ".local", "bin", "claude")),
    `expected the default to sit under HOME, got: ${result.stderr.slice(0, 400)}`);
  assert.doesNotMatch(result.stderr, /johnpotter/, "no developer's username survives in the default");
});
