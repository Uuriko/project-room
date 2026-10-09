import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runner = new URL("../scripts/native-host-request-run.mjs", import.meta.url).pathname;

test("native-host runner refuses invalid invocations without starting a host", () => {
  for (const args of [[], ["unknown", "unused", "review", "unused"], ["claude", "unused", "unknown", "unused"]]) {
    const r = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 2); assert.match(r.stderr, /Usage: node scripts\/native-host-request-run\.mjs/);
  }
});

test("existing native evidence refuses before model execution and remains untouched", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = join(directory, "fixture.json"), output = join(directory, "evidence.json");
  writeFileSync(metadata, JSON.stringify({ origin: "http://127.0.0.1:1", directory, participants: [{ memberId: "reviewer",
    configDirectory: join(directory, "missing-config"), attentionDirectory: join(directory, "missing-attention") }] }));
  writeFileSync(output, "Original evidence");
  for (const host of ["codex", "claude"]) {
    const r = spawnSync(process.execPath, [runner, host, metadata, "review", output], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), "Original evidence");
  }
});

test("unreadable fixture metadata records a not-started evidence result without throwing or spawning", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "spawned"), fakeBin = join(directory, "fake-host");
  writeFileSync(fakeBin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const output = join(directory, "evidence.json");
  const r = spawnSync(process.execPath, [runner, "codex", join(directory, "missing-fixture.json"), "review", output],
    { encoding: "utf8", timeout: 15000, env: { ...process.env, ROOM_NATIVE_CODEX_BIN: fakeBin } });
  assert.equal(r.status, 1);
  assert.ok(!/^\s+at /m.test(r.stderr), `no stack trace on stderr, got: ${r.stderr}`);
  assert.equal(existsSync(marker), false, "a fixture failure must not start the host");
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(evidence.host, "codex"); assert.equal(evidence.phase, "review");
  assert.match(evidence.fixtureError, /missing-fixture\.json/);
  assert.match(evidence.boundary, /No native host was started/);
});

test("invalid or non-loopback fixture metadata records a not-started evidence result", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    ["invalid.json", "{not json", /fixture metadata/],
    ["no-participants.json", JSON.stringify({ origin: "http://127.0.0.1:1", directory }), /participants/],
    ["wrong-participant.json", JSON.stringify({ origin: "http://127.0.0.1:1", directory,
      participants: [{ memberId: "producer" }] }), /reviewer/],
    ["non-loopback.json", JSON.stringify({ origin: "https://example.com", directory,
      participants: [{ memberId: "reviewer" }] }), /loopback/],
  ];
  for (const [name, body, expected] of cases) {
    const metadata = join(directory, name), output = join(directory, name + ".evidence.json");
    writeFileSync(metadata, body);
    const r = spawnSync(process.execPath, [runner, "codex", metadata, "review", output], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 1, name);
    assert.ok(!/^\s+at /m.test(r.stderr), `no stack trace on stderr for ${name}, got: ${r.stderr}`);
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.match(evidence.fixtureError, expected, name);
    assert.match(evidence.boundary, /No native host was started/, name);
  }
});
