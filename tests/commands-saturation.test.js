// WAVE-300 FIX-1: POST /api/rooms/{roomId}/commands must fail fast under
// burst — prompt 429/503 + Retry-After, never a silent hang — and keep the
// existing command-id exactly-once replay so a timed-out request can be
// retried safely.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

// Wait until the server's in-flight gate reaches the expected depth, so
// saturation tests are deterministic instead of timing-dependent.
async function waitForDepth(server, depth, timeoutMs = 10000) {
  const t0 = Date.now();
  while (server.commandsInFlight() < depth) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`gate depth never reached ${depth}`);
    await sleep(25);
  }
}

const cmd = (id, n) => ({ id, type: "message.posted", data: { messageId: `sat-${n}`, body: `saturation probe ${n}` } });

const postCmd = (origin, secret, bodyObj, timeoutMs = 15000) =>
  fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });

// A body that arrives in chunks over ~1s, so this request holds the
// in-flight gate while other requests arrive behind it.
const tricklePostCmd = (origin, secret, bodyObj, { chunks = 4, gapMs = 250 } = {}) => {
  const text = JSON.stringify(bodyObj);
  const part = Math.ceil(text.length / chunks);
  let i = 0;
  const stream = new ReadableStream({
    async start(controller) {
      for (; i < chunks; i++) {
        controller.enqueue(Buffer.from(text.slice(i * part, (i + 1) * part)));
        await sleep(gapMs);
      }
      controller.close();
    },
  });
  return fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: stream,
    duplex: "half",
    signal: AbortSignal.timeout(15000),
  });
};

test("saturated /commands fails fast with 503 + Retry-After instead of hanging", async t => {
  process.env.COMMANDS_MAX_INFLIGHT = "1";
  process.env.COMMANDS_SATURATED_RETRY_AFTER_S = "1";
  try {
    const f = createAcceptanceFixture();
    const { origin, server } = await startServer(t, f);
    // A holds the single in-flight slot with a trickling body (~1s).
    const aPromise = tricklePostCmd(origin, f.keys.owner, cmd(randomUUID(), 1));
    await waitForDepth(server, 1); // A's handler is deterministically inside the gate
    const t0 = Date.now();
    const b = await postCmd(origin, f.keys.owner, cmd(randomUUID(), 2));
    const bMs = Date.now() - t0;
    assert.equal(b.status, 503, "overflow request is refused, not queued behind the burst");
    assert.equal(b.headers.get("retry-after"), "1", "503 carries Retry-After");
    const bJson = await b.json();
    assert.equal(bJson.error.code, "commands_saturated");
    assert.match(bJson.error.message, /not applied/i, "refusal is definitive: the command was not applied");
    assert.ok(bMs < 5000, `prompt refusal, took ${bMs}ms`);
    const a = await aPromise;
    assert.equal(a.status, 201, "the admitted request still applies normally");
    await a.json();
  } finally {
    delete process.env.COMMANDS_MAX_INFLIGHT;
    delete process.env.COMMANDS_SATURATED_RETRY_AFTER_S;
  }
});

test("concurrent burst against a saturated gate: prompt 503s, no silent timeouts", async t => {
  process.env.COMMANDS_MAX_INFLIGHT = "4";
  try {
    const f = createAcceptanceFixture();
    const { origin, server } = await startServer(t, f);
    // Saturate the gate deterministically: 4 parked requests hold it with
    // slow bodies while the burst arrives behind them.
    const parked = [0, 1, 2, 3].map(i =>
      tricklePostCmd(origin, f.keys.owner, cmd(randomUUID(), 500 + i), { chunks: 20, gapMs: 100 }));
    await waitForDepth(server, 4);
    // The LOAD-guild burst shape: many concurrent POSTs to /commands.
    const N = 24;
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      postCmd(origin, f.keys.owner, cmd(randomUUID(), 100 + i))));
    const burstMs = Date.now() - t0;
    for (const res of results) {
      assert.equal(res.status, 503, "every burst arrival past the gate is refused, not queued");
      assert.ok(res.headers.get("retry-after"), "every 503 carries Retry-After");
      const body = await res.json();
      assert.equal(body.error.code, "commands_saturated");
      assert.match(body.error.message, /not applied/i, "refusal is definitive: not applied");
    }
    assert.ok(burstMs < 5000, `prompt refusals for ${N} concurrent: ${burstMs}ms total`);
    t.diagnostic(`burst: ${N}x503 in ${burstMs}ms while gate saturated`);
    // The parked requests that held the gate still apply normally.
    for (const p of parked) {
      const res = await p;
      assert.equal(res.status, 201, "admitted request applies despite the burst");
      await res.json();
    }
  } finally {
    delete process.env.COMMANDS_MAX_INFLIGHT;
  }
});

test("a timed-out command retries safely with the same id: exactly-once", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const id = randomUUID();
  const first = await postCmd(origin, f.keys.owner, cmd(id, 201));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.equal(firstJson.duplicate, false);
  // Same id, same content (the client-side-timeout retry): idempotent replay,
  // not a second event.
  const retry = await postCmd(origin, f.keys.owner, cmd(id, 201));
  assert.equal(retry.status, 200);
  const retryJson = await retry.json();
  assert.equal(retryJson.duplicate, true);
  assert.equal(retryJson.sequence, firstJson.sequence, "retry replays the original result");
  // Same id, different content: 409, never a silent overwrite or double apply.
  const conflict = await postCmd(origin, f.keys.owner,
    { id, type: "message.posted", data: { messageId: "sat-201-x", body: "different content" } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  // Exactly one event for the retried command in the room log.
  const eventsRes = await fetch(`${origin}/api/rooms/commons/events?limit=100`,
    { headers: { authorization: `Bearer ${f.keys.owner}` } });
  assert.equal(eventsRes.status, 200);
  const matches = (await eventsRes.json()).events.filter(e => e?.event?.data?.messageId === "sat-201");
  assert.equal(matches.length, 1, "exactly one event applied for the retried command");
});

test("low-concurrency commands keep normal latency (no regression)", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const res = await postCmd(origin, f.keys.owner, cmd(randomUUID(), 300 + i));
    const ms = Date.now() - t0;
    assert.equal(res.status, 201);
    await res.json();
    assert.ok(ms < 2000, `normal-path latency ${ms}ms`);
  }
});
