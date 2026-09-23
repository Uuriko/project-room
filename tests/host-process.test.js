import test from "node:test";
import assert from "node:assert/strict";
import { configuredHost } from "../client/host-process.mjs";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const host = (code, extra = {}) => configuredHost({ command: process.execPath, args: ["-e", code], cwd: process.cwd(), timeoutMs: 2000, ...extra });
test("default host env omits HOME so a room path stays literal", async () => {
  const operatorHome = process.env.HOME;
  assert.equal(typeof operatorHome, "string");
  assert.ok(operatorHome.length > 1);
  const code = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const v=JSON.parse(input);const text=v.messages[0].text;const expanded=process.env.HOME?text.replace(/^~/,process.env.HOME):text;process.stdout.write(JSON.stringify({body:JSON.stringify({home:process.env.HOME??null,path:process.env.PATH??null,tmpdir:process.env.TMPDIR??null,lang:process.env.LANG??null,text,expanded})}));});`;
  const observed = JSON.parse((await host(code)({ messages: [{ text: "~/secret" }] })).body);
  assert.equal(observed.home, null);
  assert.equal(observed.text, "~/secret");
  assert.equal(observed.expanded, "~/secret");
  assert.equal(observed.expanded.includes(operatorHome), false);
  assert.equal(observed.path, process.env.PATH ?? null);
  assert.equal(observed.tmpdir, process.env.TMPDIR ?? null);
  assert.equal(observed.lang, process.env.LANG ?? null);
});
test("explicit host config can still set HOME", async () => {
  const result = await host(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({body:process.env.HOME??''})));`, { env: { HOME: "/configured/host-home" } })({});
  assert.equal(result.body, "/configured/host-home");
});
test("host process receives JSON, literal arguments and only explicitly allowed environment", async () => {
  process.env.ROOM_HOST_TEST_SECRET = "must-not-inherit";
  try {
    const result = await host(`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const v=JSON.parse(input);if(process.env.ROOM_HOST_TEST_SECRET)process.exit(3);process.stdout.write(JSON.stringify({body:v.requestId+':'+process.env.EXPLICIT_HOST_SETTING}));});`, { env: { EXPLICIT_HOST_SETTING: "configured" } })({ requestId: "hello" });
    assert.equal(result.body, "hello:configured");
  } finally { delete process.env.ROOM_HOST_TEST_SECRET; }
});
for (const [name, code, expected] of [
  ["malformed", "console.log('not JSON')", /JSON/],
  ["nonzero", "process.stderr.write('private diagnostic');process.exit(2)", /unsuccessfully/],
  ["oversized", "process.stdout.write('x'.repeat(40000));setInterval(()=>{},1000)", /32 KiB/],
  ["empty", "console.log(JSON.stringify({body:''}))", /JSON/]
]) test(`host ${name} output fails without exposing diagnostics`, async () => {
  await assert.rejects(host(code)({}), error => expected.test(error.message) && !error.message.includes("private diagnostic"));
});
test("timeout and cancellation stop host processes", async () => {
  await assert.rejects(host("setInterval(()=>{},1000)", { timeoutMs: 100 })({}), /timed out/);
  const controller = new AbortController();
  const pending = host("setInterval(()=>{},1000)")({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test("invalid executable configuration is rejected before execution", () => {
  assert.throws(() => configuredHost({ command: "node", args: [], cwd: process.cwd(), timeoutMs: 1000 }), /absolute/);
});
test("unserializable input never starts a host with side effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "room-host-preflight-"));
  const marker = join(directory, "started");
  try {
    const execute = host(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`, { timeoutMs: 100 });
    const circular = {}; circular.self = circular;
    for (const input of [circular, { value: 1n }]) {
      await assert.rejects(execute(input), /JSON serializable/);
    }
    // A mistakenly spawned process has time to write before its timeout kills it.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("different host processes cannot write the same checkout concurrently", async () => {
  const controller = new AbortController();
  const first = host("setInterval(()=>{},1000)")({ signal: controller.signal });
  const stopped = assert.rejects(first, /cancelled/);
  try { await assert.rejects(host("console.log(JSON.stringify({body:'collision'}))")({}), /active or unresolved host/); }
  finally { controller.abort(); await stopped; }
  assert.equal((await host("console.log(JSON.stringify({body:'released'}))")({})).body, "released");
});

test("process adapter accepts optional coding evidence without replacing its bytes", async () => {
  const result = { body: "Fixed.", codeResult: { repositoryUrl: "https://example.com/repo", baseRevision: "a".repeat(40),
    patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+after\n", files: ["a"], checks: [] } };
  assert.deepEqual(await host(`console.log(${JSON.stringify(JSON.stringify(result))})`)({}), result);
});
