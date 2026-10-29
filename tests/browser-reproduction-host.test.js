import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runBrowserReproduction, classifyReproduction } from "../scripts/browser-reproduction-host.mjs";
import { hostSubprocess } from "../client/host-subprocess.mjs";

const name = "selected [x].*";
const tap = (status = "ok", suffix = "") => Buffer.from(`TAP version 13\n${status} 1 - ${name}${suffix}\n1..1\n# pass ${status === "ok" ? 1 : 0}\n# fail ${status === "ok" ? 0 : 1}\n`);
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reproduce-host-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"); mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "scripts/browser-check.mjs"), `import test from 'node:test'; test(${JSON.stringify(name)},()=>{});\n`);
  const git = realpathSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
  const command = args => execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: checkout, encoding: "utf8" }).trim();
  command(["init", "-q"]); command(["add", "."]); command(["commit", "-qm", "fixture"]);
  return { root, checkout, command, options: { checkout, git, node: realpathSync(process.execPath), revision: command(["rev-parse", "HEAD"]), tree: command(["rev-parse", "HEAD^{tree}"]), script: "scripts/browser-check.mjs", testName: name, out: join(root, "receipt"), timeoutMs: 5000 } };
}
const child = fn => async (config, options) => config.args.includes("--test") ? fn(config, options) : hostSubprocess(config, options);

test("operator pins select an exact test; packet text never becomes argv; artifacts retain digests", async t => {
  const f = fixture(t);
  const result = await runBrowserReproduction({ ...f.options, packetId: "do-not-execute; touch /tmp/injection", packetSha256: "a".repeat(64), requestMessageId: "request", workItemId: "work" }, { run: child((config, options) => {
    assert.deepEqual(config.args, ["--test", "--test-concurrency=1", "--test-reporter=tap", "--test-name-pattern=^selected \\[x\\]\\.\\*$", "scripts/browser-check.mjs"]);
    assert.equal(options.env.ROOM_AGENT_CONFIG, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    return { stdout: tap(), exitCode: 0 };
  }) });
  assert.equal(result.receipt.outcome, "passed"); assert.equal(result.receipt.workItemId, "work");
  const bytes = readFileSync(join(f.options.out, "stdout.tap"));
  assert.equal(result.receipt.stdoutSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(result.body.length < 4096); assert.match(result.body, /no fix or release claimed/);
  await assert.rejects(runBrowserReproduction(f.options), /EEXIST/);
});

test("only one completed matching test supplies pass or fail, never skip or zero tests", () => {
  assert.equal(classifyReproduction(tap(), 0, name), "passed");
  assert.equal(classifyReproduction(tap("not ok"), 1, name), "failed");
  for (const [output, exit] of [["TAP version 13\n1..0\n# pass 0\n# fail 0", 0], [tap("ok", " # SKIP reason"), 0], [tap("not ok", " # TODO later"), 1], [tap(), 1], [Buffer.concat([tap(), tap()]), 0]])
    assert.equal(classifyReproduction(output, exit, name), "unknown");
});

for (const failure of ["timeout", "cancelled", "output exceeded", "startup"]) test(`${failure} records unknown without inventing test failure`, async t => {
  const f = fixture(t);
  const result = await runBrowserReproduction(f.options, { run: child(() => { throw new Error(failure); }) });
  assert.equal(result.receipt.outcome, "unknown"); assert.equal(result.receipt.exitCode, null);
  assert.match(result.receipt.reason, /child_incomplete/);
});

test("source pins, dirty source and unregistered scripts refuse before child execution", async t => {
  const f = fixture(t); let calls = 0;
  const run = child(() => { calls++; return { stdout: tap(), exitCode: 0 }; });
  for (const change of [{ revision: "a".repeat(40) }, { tree: "b".repeat(40) }, { script: "../scripts/browser-check.mjs" }])
    await assert.rejects(runBrowserReproduction({ ...f.options, ...change }, { run }));
  writeFileSync(join(f.checkout, "scripts/browser-check.mjs"), `import test from 'node:test'; test(${JSON.stringify(name)},()=>{}); // changed\n`);
  await assert.rejects(runBrowserReproduction(f.options, { run }), /clean tracked/);
  assert.equal(calls, 0);
});

test("tracked mutation during the child invalidates a reported pass", async t => {
  const f = fixture(t);
  const result = await runBrowserReproduction(f.options, { run: child(() => {
    writeFileSync(join(f.checkout, "scripts/browser-check.mjs"), "// changed\n");
    return { stdout: tap(), exitCode: 0 };
  }) });
  assert.equal(result.receipt.outcome, "unknown"); assert.equal(result.receipt.observedOutcome, "passed"); assert.match(result.receipt.reason, /source_or_executable_changed/);
});

test("real Node child passes the selected literal while preserving clean source", async t => {
  const f = fixture(t), result = await runBrowserReproduction(f.options);
  assert.equal(result.receipt.outcome, "passed"); assert.equal(result.receipt.exitCode, 0);
});

test("dynamic names are selected by observed TAP; nonexistent name remains unknown", async t => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "scripts/browser-check.mjs"), "import test from 'node:test'; const label='[x].*'; test(`selected ${label}`,()=>{});\n");
  f.command(["add", "."]); f.command(["commit", "-qm", "dynamic"]);
  f.options.revision = f.command(["rev-parse", "HEAD"]); f.options.tree = f.command(["rev-parse", "HEAD^{tree}"]);
  assert.equal((await runBrowserReproduction(f.options)).receipt.outcome, "passed");
  assert.equal((await runBrowserReproduction({ ...f.options, testName: "missing", out: join(f.root, "missing") })).receipt.outcome, "unknown");
});
