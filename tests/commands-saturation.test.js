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
  return `http://127.0.0.1:${server.address().port}`;
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
    const origin = await startServer(t, f);
    // A holds the single in-flight slot with a trickling body (~1s).
    const aPromise = tricklePostCmd(origin, f.keys.owner, cmd(randomUUID(), 1));
    await sleep(200); // let A's handler enter the gate
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

test("concurrent burst gets definitive statuses with no silent timeouts", async t => {
  process.env.COMMANDS_MAX_INFLIGHT = "4";
  try {
    const f = createAcceptanceFixture();
    const origin = await startServer(t, f);
    const N = 24;
    const t0 = Date.now();
    const latencies = [];
    // Trickle every body so the handlers genuinely overlap in flight, the
    // way a real burst overlaps on the wire.
    const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
      const start = Date.now();
      try {
        const res = await tricklePostCmd(origin, f.keys.owner, cmd(randomUUID(), 100 + i),
          { chunks: 4, gapMs: 100 });
        latencies.push(Date.now() - start);
        return res;
      } catch (error) {
        latencies.push(Date.now() - start);
        throw error;
      }
    }));
    const maxMs = Math.max(...latencies);
    const statuses = {};
    for (const res of results) {
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      assert.ok([201, 503].includes(res.status), `definitive status, got ${res.status}`);
      if (res.status === 503) assert.ok(res.headers.get("retry-after"), "every 503 carries Retry-After");
      await res.text(); // drain
    }
    assert.ok((statuses[201] ?? 0) >= 1, "some commands admitted");
    assert.ok((statuses[503] ?? 0) >= 1, `gate engaged under burst: ${JSON.stringify(statuses)}`);
    assert.ok(maxMs < 10000, `no hangs: max latency ${maxMs}ms for ${N} concurrent commands`);
    t.diagnostic(`burst: ${JSON.stringify(statuses)}, max latency ${maxMs}ms, total ${Date.now() - t0}ms`);
  } finally {
    delete process.env.COMMANDS_MAX_INFLIGHT;
  }
});

test("a timed-out command retries safely with the same id: exactly-once", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
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
  const origin = await startServer(t, f);
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const res = await postCmd(origin, f.keys.owner, cmd(randomUUID(), 300 + i));
    const ms = Date.now() - t0;
    assert.equal(res.status, 201);
    await res.json();
    assert.ok(ms < 2000, `normal-path latency ${ms}ms`);
  }
});
