// Oct 22: /api/ready answered 503 on 24 of 32 reads while the object was
// serving, because SELECT 1 queued behind long turns on the single-threaded
// invite-only-pilot object and crossed the 1 s bound. A timeout shortly after
// a probe that did answer is "busy"; a cold or wedged object stays degraded.
import test from "node:test";
import assert from "node:assert/strict";
import { createHealthProbe, healthLivenessResponse, readyBusyResponse, readyProbeResponse } from "../cloudflare/health-probe.mjs";

const req = () => new Request("https://room.example.test/api/ready");
const ok = () => Response.json({ status: "ok", emailVerification: "enforced" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const handlers = (extra = {}) => ({
  timeoutMs: 40,
  waitUntil: p => { p.then(() => {}, () => {}); },
  onSnapshot: (s, t) => readyProbeResponse(s, req(), { mode: "m", elapsedMs: t.elapsedMs }),
  onUnready: (r, t) => healthLivenessResponse(req(), { mode: "m", readiness: r, ...t }),
  onBusy: t => readyBusyResponse(req(), { mode: "m", ...t }),
  ...extra
});
const busyStart = ms => () => sleep(ms).then(ok);

test("a warm object that is momentarily busy reads ready/busy, not 503", async () => {
  const probe = createHealthProbe();
  assert.equal((await probe({ ...handlers(), start: ok })).status, 200);
  const res = await probe({ ...handlers(), start: busyStart(120) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ready");
  assert.equal(body.do.status, "busy");
  assert.ok(body.do.lastOkAgeMs >= 0 && body.do.lastOkAgeMs < 1000);
});

test("negative control: without onBusy the same timeout is the old 503 (the production symptom)", async () => {
  const probe = createHealthProbe();
  await probe({ ...handlers({ onBusy: undefined }), start: ok });
  const res = await probe({ ...handlers({ onBusy: undefined }), start: busyStart(120) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).do.status, "timeout");
});

test("a cold isolate with no answered probe still reads degraded", async () => {
  const probe = createHealthProbe();
  const res = await probe({ ...handlers(), start: busyStart(120) });
  assert.equal(res.status, 503);
});

test("a late answer counts as evidence for the next timeout", async () => {
  const probe = createHealthProbe();
  assert.equal((await probe({ ...handlers(), start: busyStart(80) })).status, 503);
  await sleep(100);
  assert.equal((await probe({ ...handlers(), start: busyStart(120) })).status, 200);
});

test("past the grace window a wedged object reads degraded again", async () => {
  const probe = createHealthProbe();
  await probe({ ...handlers({ busyGraceMs: 30 }), start: ok });
  await sleep(60);
  const res = await probe({ ...handlers({ busyGraceMs: 30 }), start: busyStart(120) });
  assert.equal(res.status, 503);
});

test("an error is never softened to busy", async () => {
  const probe = createHealthProbe();
  await probe({ ...handlers(), start: ok });
  const res = await probe({ ...handlers(), start: async () => { throw new Error("storage probe failed"); } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).do.status, "error");
});

test("HEAD on busy has no body", async () => {
  const res = readyBusyResponse(new Request("https://x.test/api/ready", { method: "HEAD" }), { mode: "m", elapsedMs: 1000, timeoutMs: 1000, lastOkAgeMs: 5 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});
