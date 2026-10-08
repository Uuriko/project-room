// Honest backpressure, wave300 work item 3: POST /api/admission/intent.
// Probing-intent admission — the fast path: validate strictly (400
// invalid_intent), admit fast (200), or refuse fast (429 over per-client
// budget / 503 server shedding, both with Retry-After). The decision is
// synchronous gauge reads only; the test pins that below.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer, decideIntentAdmission, setIntentAdmissionShed } from "../server/http.mjs";

const token = char => char.repeat(43); // shape-valid bearer: [A-Za-z0-9_-]{43}

async function serve(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, bearer) => fetch(`${base}/api/admission/intent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { post };
}

const valid = (over = {}) => ({
  kind: "read", target: "muse-room", rate_rps: 0.5, expected_total: 200, window_seconds: 1800, ...over,
});

test("malformed intents are 400 with code invalid_intent", async t => {
  const { post } = await serve(t);
  const cases = {
    "unknown kind": valid({ kind: "nuke" }),
    "missing kind": { target: "muse-room", rate_rps: 1, expected_total: 10, window_seconds: 60 },
    '"production" is not a target': valid({ target: "production" }),
    "blank target": valid({ target: "   " }),
    "non-string target": valid({ target: 42 }),
    "bare api: prefix": valid({ target: "api:" }),
    "zero rate": valid({ rate_rps: 0 }),
    "negative rate": valid({ rate_rps: -1 }),
    "non-number rate": valid({ rate_rps: "fast" }),
    "zero total": valid({ expected_total: 0 }),
    "fractional total": valid({ expected_total: 1.5 }),
    "zero window": valid({ window_seconds: 0 }),
    "window over 3600": valid({ window_seconds: 3601 }),
    "fractional window": valid({ window_seconds: 60.5 }),
    "non-string notes": valid({ notes: 7 }),
    "extra field": { ...valid(), oops: 1 },
  };
  for (const [name, body] of Object.entries(cases)) {
    const res = await post(body, token("A"));
    assert.equal(res.status, 400, `${name}: expected 400, got ${res.status}`);
    const json = await res.json();
    assert.equal(json.error?.code, "invalid_intent", `${name}: expected code invalid_intent, got ${JSON.stringify(json)}`);
  }
});

test("a well-formed intent is admitted fast with an intentId and budget", async t => {
  const { post } = await serve(t);
  const res = await post(valid({ kind: "write", target: "scratch:abc123", rate_rps: 2, expected_total: 50, notes: "sweep" }), token("B"));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.admitted, true);
  assert.match(json.intentId, /^[0-9a-f-]{36}$/, "intentId is a uuid");
  assert.deepEqual(json.budget, { rate_rps: 2, expected_total: 50 });
});

test("past the per-client cap the refusal is 429 over_budget with Retry-After", async t => {
  const { post } = await serve(t);
  const bearer = token("C");
  for (let i = 0; i < 3; i++) {
    const res = await post(valid({ window_seconds: 600 }), bearer);
    assert.equal(res.status, 200, `admit ${i + 1} should succeed`);
  }
  const started = Date.now();
  const refused = await post(valid(), bearer);
  const elapsed = Date.now() - started;
  assert.equal(refused.status, 429);
  const json = await refused.json();
  assert.equal(json.admitted, false);
  assert.equal(json.code, "over_budget");
  assert.ok(typeof json.retryAfterMs === "number" && json.retryAfterMs > 0, "retryAfterMs is a positive number");
  assert.ok(typeof json.reason === "string" && json.reason.length > 0, "reason explains the refusal");
  const retryAfter = refused.headers.get("retry-after");
  assert.ok(retryAfter !== null, "429 carries a Retry-After header");
  assert.equal(Number(retryAfter), Math.ceil(json.retryAfterMs / 1000), "Retry-After (seconds) matches retryAfterMs");
  // The refuse path never queues behind the work it describes: it must land
  // far inside the server's 15s request timeout even under a probe storm.
  assert.ok(elapsed < 2000, `refusal took ${elapsed}ms; the fast path must answer in microseconds-to-ms`);
});

test("the decision itself does no async I/O", async t => {
  const fresh = decideIntentAdmission("test-client-never-seen", 60);
  assert.ok(!(fresh instanceof Promise), "decision returns a plain object, not a promise");
  assert.equal(fresh.admitted, true);
  // The decision is synchronous gauge reads only: a thousand of them must
  // complete in milliseconds. Any await on the refuse path (store, timers,
  // network) would blow this budget.
  const started = Date.now();
  for (let i = 0; i < 1000; i++) {
    const decision = decideIntentAdmission(`test-client-loop-${i % 4}`, 60);
    assert.ok(!(decision instanceof Promise));
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `1000 decisions took ${elapsed}ms; the decision path must stay microsecond-scale`);
});

test("while the shed flag is set the endpoint refuses 503 shed_load", async t => {
  const { post } = await serve(t);
  setIntentAdmissionShed(true);
  t.after(() => setIntentAdmissionShed(false));
  const refused = await post(valid(), token("D"));
  assert.equal(refused.status, 503);
  const json = await refused.json();
  assert.equal(json.admitted, false);
  assert.equal(json.code, "shed_load");
  assert.ok(typeof json.retryAfterMs === "number" && json.retryAfterMs > 0);
  assert.ok(typeof json.reason === "string" && json.reason.length > 0);
  assert.ok(refused.headers.get("retry-after") !== null, "503 carries a Retry-After header");
  // Flag off again: the same client is admitted (shed was the only refusal).
  setIntentAdmissionShed(false);
  const admitted = await post(valid(), token("D"));
  assert.equal(admitted.status, 200);
});
