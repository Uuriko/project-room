import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { alertEvent, signDelivery, sendAlert, ALERT_EVENT } from "../scripts/alert-wake.mjs";

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");

test("off without both env vars: nothing is sent", async () => {
  let called = false;
  const out = await sendAlert({ source: "s", title: "t", url: "u" }, { env: {}, fetchImpl: () => { called = true; } });
  assert.equal(out.sent, false);
  assert.equal(called, false);
});

test("event is an MCP Events payload the inbound hook accepts; signature verifies", () => {
  const ev = alertEvent({ source: "deploy-prod", title: "deploy-prod failed", url: "https://github.com/x/runs/1", sha: "abc", summary: "smoke: step", eventId: "alert-1-1", now: 0 });
  assert.equal(ev.name, ALERT_EVENT);
  assert.equal(ev.eventId, "alert-1-1");
  assert.match(ev.data.body, /Revision: abc/);
  const body = JSON.stringify(ev);
  const h = signDelivery(SECRET, body, { id: ev.eventId, nowS: 100 });
  const expected = createHmac("sha256", Buffer.alloc(32, 7)).update(`alert-1-1.100.${body}`).digest("base64");
  assert.equal(h["webhook-signature"], `v1,${expected}`);
});

test("sends to the hook with signed headers and never puts the secret in the request", async () => {
  let seen;
  const out = await sendAlert({ source: "live-smoke", title: "t", url: "https://github.com/r/1", eventId: "alert-9-1" }, {
    env: { ROOM_ALERT_HOOK_URL: "https://room.example/api/inbound/ih_abc", ROOM_ALERT_HOOK_SECRET: SECRET },
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, json: async () => ({ claimId: "in-1", duplicate: false }) }; } });
  assert.deepEqual(out, { sent: true, status: 201, claimId: "in-1", duplicate: false });
  assert.equal(seen.init.headers["webhook-id"], "alert-9-1");
  assert.ok(!JSON.stringify(seen).includes(SECRET.slice(6)));
  const bad = await sendAlert({ source: "s", title: "t", url: "u" }, { env: { ROOM_ALERT_HOOK_URL: "http://x/hook", ROOM_ALERT_HOOK_SECRET: SECRET }, fetchImpl: () => assert.fail() });
  assert.equal(bad.sent, false);
});
