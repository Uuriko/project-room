// The agent-triggered process endpoint (POST /api/agent-webhooks/process)
// is the one drain caller PR-2 left without a deadline: the cron registry
// and both dispatch kicks pass cronDeadline(), the endpoint passed nothing,
// so a caller with 25 slow receivers could hold its own sweep open for the
// unbounded worst case (>= 250 s). This test pins the wiring: the endpoint
// now hands the drain the same one-job budget every cron caller gets
// (Date.now() + JOB_BUDGET_MS, the Node-side cronDeadline). The drain's
// deadline behaviour itself — stop at the bound, remainder stays pending
// in order, next tick completes it — is pinned by
// tests/webhook-escrow-deadline.test.js (PR-2).
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { JOB_BUDGET_MS } from "../server/jobs.mjs";

test("POST /api/agent-webhooks/process passes the caller its one-job deadline budget", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = f.store.identities.create("process-deadline");

  // Capture the exact options the route hands the drain, and answer with
  // a canned drained summary so the sweep itself performs no network I/O.
  const plugin = f.store.agentPlugin;
  const calls = [];
  const canned = Object.freeze({ processed: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0 });
  plugin.drainWebhookDeliveries = async options => { calls.push(options); return canned; };

  const before = Date.now();
  const res = await fetch(`${origin}/api/agent-webhooks/process`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${identity.secret}` },
    body: JSON.stringify({}),
  });
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).summary, canned, "the drain summary rides the response unchanged");

  const scoped = calls.filter(call => call?.agentId === identity.identityId);
  assert.equal(scoped.length, 1, "the endpoint drains exactly once, scoped to the caller");
  const { deadline } = scoped[0];
  assert.equal(typeof deadline, "number", "the endpoint passes a deadline (pre-fix it passed none)");
  assert.ok(Number.isFinite(deadline), "the deadline is finite, so the drain's per-attempt cap engages");
  assert.ok(deadline >= before + JOB_BUDGET_MS - 50,
    `deadline ${deadline} is a full budget from request start (${before} + ${JOB_BUDGET_MS})`);
  assert.ok(deadline <= after + JOB_BUDGET_MS,
    `deadline ${deadline} is no more than one budget past request end (${after})`);
});
