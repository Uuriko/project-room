// Dedicated rate budget for the wake poll + heartbeat doors (WAKE-S2).
//
// Authoring gate (repo test-audit): each test below names the observable
// contract, the credible regression, why existing coverage misses it, and
// confirms no test-only production seam was added.
//
// 1. Continuous-poll cadence is admitted — contract: a host polling
//    GET /api/agent-wakes/poll back-to-back (the shape a checker takes
//    whenever an unacked signal makes every poll return instantly, and
//    whenever several hosts/invocations overlap) is served by the
//    dedicated agent-wake-poll budget, sized for the hold pattern.
//    Regression: the pre-WAKE-S2 cap of 30/identity/minute throttled
//    exactly this cadence — MIG-WAKE measured 2,807 of 7,025 live bridge
//    invocations (40.0%) degrading on `wake poll HTTP 429`.
//    Existing coverage misses it: agent-wake-poll.test.js polls a handful
//    of times per test; nothing drives a sustained cadence.
// 2. Burst abuse still refuses, from the dedicated bucket — contract:
//    past the budget the door answers 429 rate_limited and the
//    X-RateLimit-Bucket header names agent-wake-poll / agent-heartbeat,
//    so the refusal is the endpoints' own budget doing its job, not a
//    shared bucket starving the wake path. Regression: an "exempt the
//    poll entirely" fix would leave the door unbounded.
// 3. The heartbeat budget is per identity, not per address — contract:
//    POST /api/agent-heartbeats is budgeted per identity, so agents
//    sharing one egress address (a fleet behind one NAT/VM) never spend
//    each other's heartbeat budget. Regression: the pre-WAKE-S2 bucket
//    keyed on the remote address at 120/minute, so one busy identity
//    could starve every other identity on the same address.
//
// Synthetic fixtures only — loopback HTTP, no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function keyedAgent(t, f, origin, name) {
  const identity = f.store.identities.create(name);
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  return { identity, credential: scoped.credential };
}

test("wake poll: continuous cadence admitted by the dedicated budget; burst past it refuses from that bucket", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { credential } = await keyedAgent(t, f, origin, "wake-budget-poller");
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential)).status, 200);

  // Continuous-poll cadence: short polls back-to-back, the shape a checker
  // takes while a signal sits pending and every poll returns instantly.
  // 150 in a row is 5x the pre-WAKE-S2 per-minute cap.
  const CADENCE = 150;
  for (let i = 0; i < CADENCE; i++) {
    const res = await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential);
    assert.equal(res.status, 200, `continuous poll #${i + 1} must be admitted`);
    await res.json();
  }

  // Burst leg: keep driving far past the budget. The first refusal must
  // arrive, its error must be rate_limited, and its bucket header must
  // name the dedicated agent-wake-poll family.
  let admitted = CADENCE;
  let refusal = null;
  for (let wave = 0; wave < 12 && !refusal; wave++) {
    const batch = await Promise.all(Array.from({ length: 50 },
      () => get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential)));
    for (const res of batch) {
      if (res.status === 200) { admitted++; await res.json(); }
      else { refusal = res; break; }
    }
  }
  assert.ok(refusal, "a burst far above the budget must eventually refuse");
  assert.equal(admitted, 600, "the dedicated poll budget admits exactly its sized cadence before refusing");
  assert.equal(refusal.status, 429);
  assert.equal(refusal.headers.get("x-ratelimit-bucket"), "agent-wake-poll");
  assert.equal((await refusal.json()).error?.code, "rate_limited");
});

test("heartbeat: budget is per identity — a busy identity cannot starve another on the same address, and a burst still refuses", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const a = await keyedAgent(t, f, origin, "wake-budget-heartbeat-a");
  const b = await keyedAgent(t, f, origin, "wake-budget-heartbeat-b");

  // Identity A heartbeats well past the old per-address cap of 120/min.
  // Both identities share the loopback remote address, so under the old
  // keying A's cadence alone would exhaust the shared bucket.
  const CADENCE = 150;
  for (let i = 0; i < CADENCE; i++) {
    const res = await post(origin, "/api/agent-heartbeats", { hostId: "h-a" }, a.credential);
    assert.equal(res.status, 200, `heartbeat #${i + 1} from identity A must be admitted`);
    await res.json();
  }
  // Identity B's first heartbeat from the same address is unaffected.
  const bFirst = await post(origin, "/api/agent-heartbeats", { hostId: "h-b" }, b.credential);
  assert.equal(bFirst.status, 200, "identity B keeps its own heartbeat budget on a shared address");
  await bFirst.json();

  // Burst leg: A drives past its own per-identity budget and refuses,
  // with the bucket header naming the dedicated agent-heartbeat family.
  let admitted = CADENCE;
  let refusal = null;
  for (let i = CADENCE; i < 340 && !refusal; i++) {
    const res = await post(origin, "/api/agent-heartbeats", { hostId: "h-a" }, a.credential);
    if (res.status === 200) { admitted++; await res.json(); }
    else refusal = res;
  }
  assert.ok(refusal, "a heartbeat burst far above the budget must eventually refuse");
  assert.equal(admitted, 300, "the dedicated heartbeat budget admits exactly its sized cadence before refusing");
  assert.equal(refusal.status, 429);
  assert.equal(refusal.headers.get("x-ratelimit-bucket"), "agent-heartbeat");
  assert.equal((await refusal.json()).error?.code, "rate_limited");
});
