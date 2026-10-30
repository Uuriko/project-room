import test from "node:test";
import assert from "node:assert/strict";
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
