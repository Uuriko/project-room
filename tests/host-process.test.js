import test from "node:test";
import assert from "node:assert/strict";
import { configuredHost } from "../client/host-process.mjs";
const host = (code, extra = {}) => configuredHost({ command: process.execPath, args: ["-e", code], cwd: process.cwd(), timeoutMs: 2000, ...extra });
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
