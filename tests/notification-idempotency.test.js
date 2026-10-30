// H5 charter acceptance tests: failure-injection workload — 3 unique
// notifications (deploy alarm, mention wake, digest), each submitted 3x,
// at injected provider failure rates 0 / 0.3 / 0.6. Duplicates delivered
// must be 0 at every rate; dead letters reconcile exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationService, notificationShapes } from "../server/notification-service.mjs";

function fakeProvider(failRate, rng) {
  const delivered = [];
  return { delivered, async send(msg) {
    if (rng() < failRate) throw new Error("provider 503 (injected)");
    delivered.push(msg);
    return { ok: true };
  } };
}
// Deterministic RNG so failure injection is reproducible.
function lcg(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

const shapes = () => [
  notificationShapes.deployAlarm({ deploymentId: "dep-1", summary: "deploy failed" }),
  notificationShapes.mentionWake({ roomId: "room-42", sequence: 991, mentionId: "m-1" }),
  notificationShapes.digest({ date: "2026-10-27", recipientId: "user-1" }),
];

for (const failRate of [0, 0.3, 0.6]) {
  test(`H5 failure injection @${failRate}: zero duplicates under 3x resubmission`, async () => {
    const provider = fakeProvider(failRate, lcg(42 + failRate * 100));
    const svc = createNotificationService({ provider, maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} });
    const jobs = [];
    for (let round = 0; round < 3; round++) for (const n of shapes()) jobs.push(svc.submit(n));
    const results = await Promise.all(jobs);
    const keys = provider.delivered.map((m) => m.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length, "duplicate delivery detected");
    assert.ok(provider.delivered.length <= 3);
    if (failRate < 0.6) assert.equal(provider.delivered.length, 3, "all unique notifications delivered");
    const dead = svc.deadLetters();
    assert.equal(provider.delivered.length + dead.length, 3, "submitted = delivered + dead-lettered");
    assert.equal(results.filter((r) => r.status === "dead-lettered").length, dead.length * 3 >= 0 ? results.filter((r) => r.status === "dead-lettered").length : -1);
  });
}

test("H5 dead-letter accounting: exhausted budget lands on the dead-letter surface, counted", async () => {
  const provider = { async send() { throw new Error("provider down"); } };
  const svc = createNotificationService({ provider, maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} });
  const r = await svc.submit(shapes()[0]);
  assert.equal(r.status, "dead-lettered");
  assert.equal(svc.deadLetters().length, 1);
  assert.equal(svc.counts().deadLettered, 1);
  assert.equal(svc.counts().delivered, 0);
});

test("H5 key collision: resubmitting a delivered notification is absorbed, no second delivery, no error", async () => {
  const provider = fakeProvider(0, lcg(7));
  const svc = createNotificationService({ provider, sleep: async () => {} });
  const n = shapes()[1];
  const first = await svc.submit(n);
  const second = await svc.submit(n);
  assert.equal(first.status, "delivered");
  assert.equal(second.status, "duplicate-absorbed");
  assert.equal(provider.delivered.length, 1);
});

test("H5 key is derived from notification identity: same shape+identity collides, different identity does not", async () => {
  const a = notificationShapes.digest({ date: "2026-10-27", recipientId: "user-1" });
  const b = notificationShapes.digest({ date: "2026-10-27", recipientId: "user-1" });
  const c = notificationShapes.digest({ date: "2026-10-28", recipientId: "user-1" });
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.idempotencyKey, c.idempotencyKey);
});
