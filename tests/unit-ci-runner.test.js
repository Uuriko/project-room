import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runTestFiles } from "../scripts/unit-ci.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", "unit-ci", name);

test("runTestFiles returns status 0 and no failures when all pass", () => {
  const { status, signal, failures } = runTestFiles([fixture("pass-probe.mjs")]);
  assert.equal(status, 0);
  assert.equal(signal, null);
  assert.deepEqual(failures, []);
});

test("runTestFiles names the failing test on a red run", () => {
  const { status, failures } = runTestFiles([
    fixture("pass-probe.mjs"),
    fixture("fail-probe.mjs"),
  ]);
  assert.notEqual(status, 0);
  assert.ok(
    failures.some((f) => f.includes("probe fails deterministically")),
    `expected the failing probe name, got: ${JSON.stringify(failures)}`
  );
});

// Exercise an actual interrupted runner: diagnostics must exist before the
// child finishes, and interruption must never create a successful receipt.
test("runTestFiles streams and persists progress before an interrupted run finishes", { timeout: 20000, skip: process.platform === "win32" ? "process-group interruption probe requires POSIX" : false }, async t => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(join(tmpdir(), "unit-progress-probe-"));
  const probe = join(directory, "held-probe.mjs");
  const junitPath = join(directory, "report.xml");
  const receipt = join(directory, "receipt.json");
  writeFileSync(probe, `import test from 'node:test';
    test('completed before interruption', () => {});
    test('held until interrupted', async () => { await new Promise(resolve => setTimeout(resolve, 60000)); });\n`);
  const runner = new URL("../scripts/unit-ci.mjs", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runTestFiles } from ${JSON.stringify(runner)};
    import { writeFileSync } from 'node:fs';
    const result = runTestFiles([${JSON.stringify(probe)}], { junitPath: ${JSON.stringify(junitPath)} });
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(result));
  `], { env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once("close", (status, signal) => resolve({ status, signal })));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  t.after(async () => { stop(); await closed; rmSync(directory, { recursive: true, force: true }); });
  const progressPath = `${junitPath}.progress.ndjson`;
  const readProgress = () => existsSync(progressPath)
    ? readFileSync(progressPath, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const deadline = Date.now() + 10000;
  while (!(stdout.includes("completed before interruption") && readProgress().some(event => event.type === "test:dequeue" && event.name === "held until interrupted"))) {
    assert.ok(Date.now() < deadline, `progress was not streamed before completion: ${stdout}\n${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(child.exitCode, null, "the suite is still running while diagnostics are readable");
  assert.match(readFileSync(`${junitPath}.spec.log`, "utf8"), /completed before interruption/);
  stop();
  const outcome = await closed;
  assert.notEqual(outcome.status, 0);
  assert.equal(existsSync(receipt), false, "no completed receipt is fabricated on cancellation");
  assert.ok(readProgress().some(event => event.type === "test:complete" && event.name === "completed before interruption"));
  assert.ok(readProgress().some(event => event.type === "test:dequeue" && event.name === "held until interrupted"));
  assert.equal(readProgress().some(event => event.type === "test:complete" && event.name === "held until interrupted"), false);
});
