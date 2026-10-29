import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../machine/lib/spawn.mjs";

for (const mode of ["stdout", "stderr", "mixed"]) {
  test(`machine command bounds ${mode} output and terminates the producer`, async () => {
    const script = mode === "mixed"
      ? "process.stdout.write(Buffer.alloc(600)); process.stderr.write(Buffer.alloc(600)); setInterval(() => {}, 1000);"
      : `process.${mode}.write(Buffer.alloc(2048)); setInterval(() => {}, 1000);`;
    const result = await runCommand(process.execPath, ["-e", script], { maxBytes: 1024, timeoutMs: 1500 });
    assert.equal(result.capped, true);
    assert.equal(result.timedOut, false);
    assert.ok(result.stdout.length + result.stderr.length <= 1024);
    assert.notEqual(result.code, 0);
  });
}

test("machine command preserves both streams at the exact shared limit", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('hello'); process.stderr.write('world'); process.exitCode = 7;"], { maxBytes: 10 });
  assert.equal(result.stdout.toString(), "hello");
  assert.equal(result.stderr.toString(), "world");
  assert.equal(result.code, 7);
  assert.equal(result.capped, false);
  assert.equal(result.timedOut, false);
});

test("machine command timeout still terminates a silent producer", async () => {
  const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.capped, false);
});
