import test from "node:test";
import assert from "node:assert/strict";
import { hostSubprocess } from "../client/host-subprocess.mjs";
const command = code => ({ command: process.execPath, args: ["-e", code], timeoutMs: 2000 });
test("no-input checks receive closed stdin and preserve an immediate failing exit", async () => {
  const result = await hostSubprocess(command("console.log(require('fs').fstatSync(0).isFIFO());process.exit(7)"), { cwd: process.cwd(), env: {} });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout.toString().trim(), "false");
});
test("a host refusing actual request input still fails rather than claiming successful delivery", async () => {
  await assert.rejects(hostSubprocess(command("process.exit(0)"), {
    cwd: process.cwd(), env: {}, input: "x".repeat(8 * 1024 * 1024)
  }), /input failed/);
});
