import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runner = new URL("../scripts/native-host-request-run.mjs", import.meta.url).pathname;

test("native-host runner refuses invalid invocations without starting a host", () => {
  for (const args of [[], ["unknown", "unused", "review", "unused"], ["claude", "unused", "unknown", "unused"]]) {
    const r = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /Choose host, fixture metadata, phase/);
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
    const r = spawnSync(process.execPath, [runner, host, metadata, "review", output], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), "Original evidence");
  }
});
