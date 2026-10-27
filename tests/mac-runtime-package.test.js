import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { packageMacRuntime } from "../scripts/package-mac-runtime.mjs";

test("Mac runtime runs outside checkout with verified closure and no installed packages", t => {
  const root = mkdtempSync(join(tmpdir(), "room-mac-package-")), output = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = packageMacRuntime(fileURLToPath(new URL("../", import.meta.url)), output);
  assert.ok(result.files > 1);
  const manifest = JSON.parse(readFileSync(join(output, "runtime-manifest.json")));
  for (const file of manifest.files) assert.equal(createHash("sha256").update(readFileSync(join(output, file.path))).digest("hex"), file.sha256);
  assert.equal(existsSync(join(output, "server/agent-discovery.mjs")), false, "agent runtime must not package server discovery to route client URLs");
  assert.equal(existsSync(join(output, "node_modules")), false);
  assert.equal(existsSync(join(output, ".git")), false);
  const host = spawnSync(process.execPath, [join(output, "scripts/run-codex-room.mjs"), "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(host.status, 0, host.stderr); assert.match(host.stdout, /Usage:/);
  const setup = spawnSync(process.execPath, [join(output, "scripts/native-agent-setup.mjs")], { cwd: root, input: '{"action":"invalid"}', encoding: "utf8" });
  assert.equal(setup.status, 1, setup.stderr); assert.deepEqual(JSON.parse(setup.stdout), { status: "setup_failed" });
  assert.throws(() => packageMacRuntime(fileURLToPath(new URL("../", import.meta.url)), output), /must be new/);
});
