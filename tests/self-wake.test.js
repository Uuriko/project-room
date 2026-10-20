import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { nextCheckLabel, parseWakeIn } from "../src/self-wake.js";
import { parseWakeMeArgs, wakeMeCommand } from "../cli/commands/wake-me.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function agentEnv(t) {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const agent = fixture.store.identities.create("waker");
  fixture.store.identities.link(fixture.keys.owner, "commons", { identityId: agent.identityId, memberId: "waker", displayName: "Waker", permissions: ["accept_work"] });
  return { fixture, origin, env: { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: agent.secret }, secret: agent.secret };
}

test("parseWakeIn and nextCheckLabel", () => {
  assert.equal(parseWakeIn("15m"), 900000);
  assert.equal(parseWakeIn("in 15 min"), 900000);
  assert.equal(parseWakeIn("2h"), 7200000);
  assert.equal(parseWakeIn("15"), 900000, "a bare number is minutes");
  assert.equal(parseWakeIn(90), 90000, "a JSON number is seconds");
  assert.equal(parseWakeIn("8d"), null);
  assert.equal(parseWakeIn("0m"), null);
  assert.equal(parseWakeIn("soon"), null);
  assert.equal(nextCheckLabel(12 * 60000, 0), "next check in 12 min");
  assert.equal(nextCheckLabel(125 * 60000, 0), "next check in 2 h 5 min");
  assert.equal(nextCheckLabel(0, 1), "next check now");
  assert.throws(() => parseWakeMeArgs(["--wait"]), /needs a duration/);
  assert.throws(() => parseWakeMeArgs(["later"]), /duration/);
});

test("an agent schedules its own next check and the room reports it", async t => {
  const { origin, env, secret } = await agentEnv(t);
  const lines = [];
  assert.equal(await wakeMeCommand([], { env, out: l => lines.push(l) }), 0);
  assert.equal(await wakeMeCommand(["15m", "--note", "CI on #4339"], { env, out: l => lines.push(l) }), 0);
  assert.equal(await wakeMeCommand([], { env, out: l => lines.push(l) }), 0);
  assert.deepEqual(lines, ["No check scheduled.", "Scheduled: next check in 15 min.", "next check in 15 min"]);
  const view = await (await fetch(`${origin}/api/rooms/commons/self-wake`, { headers: { authorization: `Bearer ${secret}` } })).json();
  assert.equal(view.note, "CI on #4339");
  // Rescheduling sooner or later moves the one check; it never stacks or keeps the old time.
  await wakeMeCommand(["2h"], { env, out: () => {} });
  const moved = await (await fetch(`${origin}/api/rooms/commons/self-wake`, { headers: { authorization: `Bearer ${secret}` } })).json();
  assert.equal(moved.label, "next check in 2 h");
});

test("wake-me --wait blocks until the check is due", async t => {
  const { env } = await agentEnv(t);
  let clock = Date.now(), slept = 0;
  const lines = [];
  const code = await wakeMeCommand(["1m", "--wait", "--note", "look at CI"], { env, out: l => lines.push(l), now: () => clock, sleep: async ms => { slept += 1; clock += ms; } });
  assert.equal(code, 0);
  assert.ok(slept >= 1);
  assert.deepEqual(lines, ["Scheduled: next check in 1 min.", "Time to check: look at CI"]);
});

test("self-wake rejects bad input", async t => {
  const { origin, secret } = await agentEnv(t);
  const post = body => fetch(`${origin}/api/rooms/commons/self-wake`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ requestId: "r1", in: "forever" })).status, 422);
  assert.equal((await post({ requestId: "r2", in: "15m", extra: 1 })).status, 422);
  assert.equal((await post({ requestId: "r3", in: "15m", note: "x".repeat(201) })).status, 422);
});
