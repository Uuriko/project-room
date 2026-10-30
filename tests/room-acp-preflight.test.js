import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { candidates, probe } from "../room-acp/src/agents.mjs";
import { fileURLToPath } from "node:url";
import { main } from "../room-acp/src/cli.mjs";
import { loadConnection } from "../room-acp/src/credentials.mjs";
import { startRoom } from "./room-acp-fixture.mjs";
const fake = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));

test("missing adapter leaves the one-use invite redeemable and names the next step", async t => {
  const room = await startRoom(t), { link } = room.invite(), lines = [];
  const env = { ...room.env, PATH: "" };
  let requests = 0;
  assert.equal(await main([link], { env, print: line => lines.push(line), fetchImpl: () => { requests++; throw new Error("must not redeem"); } }), 1);
  assert.equal(requests, 0);
  assert.equal(loadConnection({}, env), null);
  assert.match(lines.join("\n"), /invitation has not been used/);
  assert.match(lines.join("\n"), /--agent codex/);
  let selected;
  assert.equal(await main([link, "--agent-cmd", `${process.execPath} "${fake}"`], { env, print: () => {}, run: async (_options, io) => { selected = io.candidate; return 0; } }), 0);
  assert.equal(selected.command, process.execPath);
  assert.ok(loadConnection({}, env)?.credential);
});

test("an installed command that does not speak ACP cannot consume the invite", async t => {
  const room = await startRoom(t), { link } = room.invite();
  let requests = 0;
  assert.equal(await main([link, "--agent-cmd", `${process.execPath} -e "process.exit(1)"`], { env: room.env, print: () => {}, fetchImpl: () => { requests++; throw new Error("must not redeem"); } }), 1);
  assert.equal(requests, 0);
  assert.equal(loadConnection({}, room.env), null);
});

for (const mode of ["wrong-protocol", "unauthenticated", "session-permission", "empty-session"]) {
  test(`${mode} adapter leaves the same invitation usable without sending a prompt`, async t => {
    const room = await startRoom(t), { link } = room.invite(), lines = [];
    const trace = pathJoin(room.home, "preflight-methods.txt");
    const env = { ...room.env, FAKE_ACP_MODE: mode, FAKE_ACP_TRACE: trace };
    const args = [link, "--agent-cmd", `"${process.execPath}" "${fake}"`];
    let requests = 0;
    assert.equal(await main(args, { env, print: line => lines.push(line), fetchImpl: () => { requests++; throw new Error("must not redeem"); } }), 1);
    assert.equal(requests, 0);
    assert.equal(loadConnection({}, env), null);
    assert.match(lines.join("\n"), /invitation has not been used/);
    if (mode === "unauthenticated") assert.match(lines.join("\n"), /needs a login/);
    const beforeRetry = readFileSync(trace, "utf8");
    assert.doesNotMatch(beforeRetry, /session\/prompt/);
    if (mode === "wrong-protocol") assert.doesNotMatch(beforeRetry, /session\/new/);
    if (mode === "session-permission") assert.match(beforeRetry, /permission:cancelled/);
    assert.equal(await main(args, { env: { ...env, FAKE_ACP_MODE: "echo" }, print: () => {}, run: async () => 0 }), 0);
    assert.ok(loadConnection({}, env)?.credential, "the same invitation is redeemable after setup is repaired");
    assert.doesNotMatch(readFileSync(trace, "utf8"), /session\/prompt/);
  });
}

test("session readiness keeps a hard deadline for a nonresponsive adapter", async () => {
  const [candidate] = candidates({ agentCmd: `"${process.execPath}" "${fake}"` });
  const result = await probe(candidate, { executionReady: true, sessionTimeoutMs: 50, env: { ...process.env, FAKE_ACP_MODE: "session-stall" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /session\/new timed out/);
});
