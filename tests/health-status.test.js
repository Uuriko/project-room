// F008: health endpoint payload + public status page. Pure builders and
// renderer; no store, network, timers, or route registration.
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectHealth,
  healthReply,
  httpStatusFor,
  renderStatusPage,
  HEALTH_OK,
  HEALTH_DEGRADED,
  HEALTH_UNHEALTHY,
  CHECK_OK,
  CHECK_FAIL,
} from "../src/health-status.mjs";

const FIXED_NOW = 1786684800000; // deterministic clock
const okProbe = { name: "storage", required: true, probe: () => ({ ok: true }) };
const dbProbe = { name: "database", required: true, probe: () => undefined };
const optionalProbe = { name: "metrics", required: false, probe: () => ({ ok: true }) };

test("collectHealth returns a healthy payload shape when every check passes", () => {
  const payload = collectHealth({
    service: "project-room",
    version: "9.9.9",
    uptimeMs: 12345.9,
    now: () => FIXED_NOW,
    checks: [okProbe, dbProbe, optionalProbe],
  });
  assert.equal(payload.service, "project-room");
  assert.equal(payload.version, "9.9.9");
  assert.equal(payload.status, HEALTH_OK);
  assert.equal(payload.uptimeMs, 12345);
  assert.equal(payload.checkedAt, new Date(FIXED_NOW).toISOString());
  assert.equal(payload.checks.length, 3);
  for (const check of payload.checks) {
    assert.equal(check.status, CHECK_OK);
    assert.equal(check.detail, null);
    assert.ok(typeof check.name === "string");
    assert.ok(typeof check.required === "boolean");
    assert.ok(Number.isFinite(check.latencyMs) && check.latencyMs >= 0);
  }
  assert.ok(Object.isFrozen(payload));
});

test("collectHealth defaults survive missing options", () => {
  const payload = collectHealth();
  assert.equal(payload.service, "project-room");
  assert.equal(payload.version, "0.1.0");
  assert.equal(payload.status, HEALTH_OK);
  assert.deepEqual([...payload.checks], []);
});

test("an optional check failure degrades the service but keeps HTTP 200", () => {
  const payload = collectHealth({
    now: () => FIXED_NOW,
    checks: [okProbe, { name: "metrics", required: false, probe: () => ({ ok: false, detail: "sink unreachable" }) }],
  });
  assert.equal(payload.status, HEALTH_DEGRADED);
  const metrics = payload.checks.find(check => check.name === "metrics");
  assert.equal(metrics.status, CHECK_FAIL);
  assert.equal(metrics.detail, "sink unreachable");
  assert.equal(httpStatusFor(payload.status), 200);
  const reply = healthReply(payload);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, payload);
});

test("a required check failure makes the service unhealthy with HTTP 503", () => {
  const payload = collectHealth({
    now: () => FIXED_NOW,
    checks: [okProbe, { name: "database", required: true, probe: () => { throw new Error("db gone"); } }],
  });
  assert.equal(payload.status, HEALTH_UNHEALTHY);
  const db = payload.checks.find(check => check.name === "database");
  assert.equal(db.status, CHECK_FAIL);
  assert.equal(db.detail, "db gone");
  assert.equal(httpStatusFor(payload.status), 503);
  assert.equal(healthReply(payload).status, 503);
});

test("a throwing probe never escapes collectHealth and its detail is recorded", () => {
  const payload = collectHealth({
    now: () => FIXED_NOW,
    checks: [{ name: "boom", required: true, probe: () => { throw "string thrown"; } }],
  });
  assert.equal(payload.checks[0].status, CHECK_FAIL);
  assert.equal(payload.checks[0].detail, "string thrown");
});

test("a check without a probe is recorded as a failure, not a crash", () => {
  const payload = collectHealth({ now: () => FIXED_NOW, checks: [{ name: "ghost", required: false }] });
  assert.equal(payload.checks[0].status, CHECK_FAIL);
  assert.equal(payload.status, HEALTH_DEGRADED);
});

test("httpStatusFor maps degraded to 200", () => {
  assert.equal(httpStatusFor(HEALTH_OK), 200);
  assert.equal(httpStatusFor(HEALTH_DEGRADED), 200);
  assert.equal(httpStatusFor(HEALTH_UNHEALTHY), 503);
});

test("healthReply falls back to a fresh healthy payload on bad input", () => {
  const reply = healthReply(null);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, HEALTH_OK);
});

test("renderStatusPage contains the key fields of a healthy payload", () => {
  const payload = collectHealth({ now: () => FIXED_NOW, checks: [okProbe, dbProbe] });
  const html = renderStatusPage(payload);
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.match(html, /project-room status/);
  assert.match(html, /0\.1\.0/);
  assert.match(html, /healthy/);
  assert.match(html, /storage/);
  assert.match(html, /database/);
  assert.match(html, /ok/);
  assert.match(html, new RegExp(payload.checkedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderStatusPage shows the degraded/unhealthy state and failing checks", () => {
  const payload = collectHealth({
    now: () => FIXED_NOW,
    checks: [{ name: "database", required: true, probe: () => { throw new Error("db gone"); } }],
  });
  const html = renderStatusPage(payload);
  assert.match(html, /unhealthy/);
  assert.match(html, /fail/);
  assert.match(html, /db gone/);
});

test("renderStatusPage escapes hostile check names and details", () => {
  const payload = collectHealth({
    service: "<img src=x onerror=alert(1)>",
    now: () => FIXED_NOW,
    checks: [{
      name: "<script>alert('check')</script>",
      required: true,
      probe: () => ({ ok: false, detail: `"><svg onload=alert("detail")>` }),
    }],
  });
  const html = renderStatusPage(payload);
  assert.ok(!html.includes("<script>alert('check')</script>"));
  assert.ok(html.includes("&lt;script&gt;alert('check')&lt;/script&gt;"));
  assert.ok(!html.includes('"><svg onload=alert("detail")>'));
  assert.ok(html.includes("&quot;&gt;&lt;svg onload=alert(&quot;detail&quot;)&gt;"));
  assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
});

test("renderStatusPage survives a missing or empty payload", () => {
  const html = renderStatusPage(undefined);
  assert.match(html, /healthy/);
  assert.match(html, /Dependency checks/);
});
