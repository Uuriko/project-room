import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostBinary, onPath, HOST_BINARY_ENV } from "../scripts/native-host-binary.mjs";

const runner = fileURLToPath(new URL("../scripts/native-host-request-run.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../", import.meta.url));

const temporary = t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-binary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

// A stand-in executable, so PATH resolution is exercised against a real file
// rather than a mock of the filesystem.
const fakeExecutable = (directory, name) => {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};

test("an unknown host resolves to a reason, never a guess", () => {
  const { binary, reason } = resolveHostBinary("not-a-host", {});
  assert.equal(binary, null);
  assert.match(reason, /Unknown native host/);
});

test("an absolute executable in the environment override wins", () => {
  const { binary, source } = resolveHostBinary("claude", { [HOST_BINARY_ENV.claude]: process.execPath });
  assert.equal(binary, process.execPath);
  assert.equal(source, "environment");
});

test("the override is refused when it is relative or not executable", t => {
  const directory = temporary(t);
  const relative = resolveHostBinary("claude", { [HOST_BINARY_ENV.claude]: "bin/claude" });
  assert.equal(relative.binary, null);
  assert.match(relative.reason, /absolute path/);

  const plain = join(directory, "not-executable");
  writeFileSync(plain, "text");
  chmodSync(plain, 0o644);
  const refused = resolveHostBinary("claude", { [HOST_BINARY_ENV.claude]: plain });
  assert.equal(refused.binary, null);
  assert.match(refused.reason, /not an executable file/);
});

test("PATH is walked the way a shell walks it", t => {
  const directory = temporary(t);
  const expected = fakeExecutable(directory, "claude");
  const { binary, source } = resolveHostBinary("claude", { PATH: `${join(directory, "absent")}:${directory}` });
  assert.equal(binary, expected);
  assert.equal(source, "path");
  assert.equal(onPath("claude", ""), null);
  assert.equal(onPath("../claude", directory), null, "a name with a separator is not a PATH lookup");
});

test("an uninstalled host names the variable that would fix it", () => {
  const { binary, reason } = resolveHostBinary("claude", { PATH: "" });
  assert.equal(binary, null);
  assert.match(reason, new RegExp(HOST_BINARY_ENV.claude));
});

// The regression this module exists for. Assembled from parts so that widening
// the scan later cannot make this file trip over its own fixture.
test("no committed code hardcodes a personal home directory", () => {
  const personal = new RegExp(`${sep}(Users|home)${sep}[a-z][a-z0-9._-]*${sep}`);
  const offenders = [];
  for (const area of ["scripts", "server", "src", "client"]) {
    for (const entry of readdirSync(join(repository, area), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(mjs|js|cjs|json|sh)$/.test(entry.name)) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
        if (personal.test(line)) offenders.push(`${path.slice(repository.length)}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `committed code must run on a machine that is not one developer's: ${offenders.join(", ")}`);
});

test("an unresolved host is recorded as evidence and starts nothing", t => {
  const directory = temporary(t);
  const metadata = join(directory, "fixture.json"), output = join(directory, "evidence.json");
  writeFileSync(metadata, JSON.stringify({ origin: "http://127.0.0.1:1", directory, participants: [{ memberId: "reviewer",
    configDirectory: join(directory, "missing-config"), attentionDirectory: join(directory, "missing-attention") }] }));
  const result = spawnSync(process.execPath, [runner, "claude", metadata, "review", output],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "", [HOST_BINARY_ENV.claude]: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not installed on this machine/);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.match(evidence.hostUnresolved, /not installed on this machine/);
  assert.equal(evidence.code, null);
  assert.match(evidence.boundary, /No native host was started/);
});

test("an already-used evidence path still refuses before host resolution", t => {
  const directory = temporary(t);
  const metadata = join(directory, "fixture.json"), output = join(directory, "evidence.json");
  writeFileSync(metadata, JSON.stringify({ origin: "http://127.0.0.1:1", directory, participants: [{ memberId: "reviewer",
    configDirectory: join(directory, "missing-config"), attentionDirectory: join(directory, "missing-attention") }] }));
  writeFileSync(output, "Original evidence");
  const result = spawnSync(process.execPath, [runner, "claude", metadata, "review", output],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "", [HOST_BINARY_ENV.claude]: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/, "evidence reservation must keep precedence over host resolution");
  assert.equal(readFileSync(output, "utf8"), "Original evidence");
});
