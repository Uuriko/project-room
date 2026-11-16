// room-acp keeps a claim's lease alive while the agent's turn runs, stops the
// moment the turn ends, and never turns a refusal into a retry storm.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { RoomClient, RoomError } from "../room-acp/src/room.mjs";

const signal = { signalId: "assigned-1", workClaim: "work", reason: "assigned" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(t, { turnMs, claim = {}, renew }) {
  const home = mkdtempSync(join(tmpdir(), "lease-renew-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = { renews: [], notes: 0, prompts: 0, logs: [] };
  const bridge = new Bridge({ connection: { apiBase: "http://localhost", roomId: "r", memberId: "agent", hostId: "h" }, env: { ROOM_ACP_HOME: home },
    log: line => calls.logs.push(line), host: {
      session: async () => ({ sessionId: "s" }),
      prompt: async () => { calls.prompts++; await sleep(turnMs); return { recorder: { text: "done", tools: new Map() }, stopReason: "end_turn" }; },
    } });
  bridge.leaseRenew = { min: 10, max: 40, fallback: 20, limit: 48 };
  bridge.me = { id: "agent" }; bridge.ownerId = "owner"; bridge.members = { owner: { kind: "human", active: true } };
  bridge.fencingToken = "test-listener";
  bridge.room.checkListener = async () => ({ listener: { valid: true } });
  bridge.room.room = async () => ({ state: { room: { ownerId: "owner" }, members: { owner: { id: "owner", kind: "human", active: true }, agent: { id: "agent", active: true } } } });
  bridge.room.claim = async () => ({ id: "work", owner: "agent", history: [{ action: "created", agentId: "owner" }], ...claim });
  bridge.room.claimNote = async () => { calls.notes++; };
  bridge.room.ack = async () => {};
  bridge.room.renewClaim = async (id, token) => { calls.renews.push([id, token]); return renew ? renew(calls.renews.length) : { leaseExpiresAt: new Date(Date.now() + 120).toISOString() }; };
  return { bridge, calls };
}
async function run(bridge) { await bridge.accept(signal); await bridge.queue.idle(); }
const lease = ms => ({ leaseExpiresAt: new Date(Date.now() + ms).toISOString() });

test("a long turn renews the lease several times, with the listener fence, then stops", async t => {
  const { bridge, calls } = setup(t, { turnMs: 400, claim: lease(60) });
  await run(bridge);
  assert.ok(calls.renews.length >= 3, `renewals during the turn: ${calls.renews.length}`);
  assert.ok(calls.renews.every(([id, token]) => id === "work" && token === "test-listener"));
  const during = calls.renews.length;
  await sleep(120);
  assert.equal(calls.renews.length, during, "no renewal after the turn ended");
  assert.equal(calls.notes, 1);
});

test("a short turn finishes before the first renewal is due", async t => {
  const { bridge, calls } = setup(t, { turnMs: 5, claim: lease(60_000) });
  await run(bridge);
  assert.equal(calls.renews.length, 0);
  assert.equal(calls.prompts, 1);
});

test("a claim with no lease is not renewed", async t => {
  const { bridge, calls } = setup(t, { turnMs: 150, claim: { leaseExpiresAt: null } });
  await run(bridge);
  assert.equal(calls.renews.length, 0);
});

test("a refused renewal ends renewal for that turn without failing the turn or retrying", async t => {
  const { bridge, calls } = setup(t, { turnMs: 300, claim: lease(60), renew: () => { throw new RoomError(409, "claim_lease_lapsed", "lapsed"); } });
  await run(bridge);
  assert.equal(calls.renews.length, 1, "one refused attempt, no retry");
  assert.equal(calls.notes, 1, "the turn still completes and posts its result");
  assert.ok(calls.logs.some(line => /lease not renewed \(claim_lease_lapsed\)/.test(line)));
});

test("renewals per turn are capped", async t => {
  const { bridge, calls } = setup(t, { turnMs: 300, claim: lease(60) });
  bridge.leaseRenew = { min: 5, max: 5, fallback: 5, limit: 3 };
  await run(bridge);
  assert.equal(calls.renews.length, 3);
});

test("RoomClient.renewClaim posts a bare heartbeat to the claim's renew route", async () => {
  const seen = [];
  const client = new RoomClient({ apiBase: "http://room.test", roomId: "r 1", credential: "tok", fetchImpl: async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ leaseExpiresAt: "2026-11-15T12:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const value = await client.renewClaim("work/1", "fence");
  assert.equal(seen[0].url, "http://room.test/api/rooms/r%201/work-claims/work%2F1/renew");
  assert.equal(seen[0].options.method, "POST");
  assert.equal(seen[0].options.body, "{}");
  assert.equal(seen[0].options.headers["x-room-listener-token"], "fence");
  assert.equal(value.leaseExpiresAt, "2026-11-15T12:00:00.000Z");
});
