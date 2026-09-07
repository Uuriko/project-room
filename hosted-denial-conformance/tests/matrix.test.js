import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DENIAL_CONTRACTS,
  HOSTED_CHECK_GAP,
  MATRIX,
  MATRIX_IDS,
  PIN,
  STAGING,
  matrixReport
} from "../src/index.js";

test("pin is draft PR #23 tip, not Instinct #8", () => {
  assert.equal(PIN.pull, 23);
  assert.equal(PIN.notInstinctPull, 8);
  assert.equal(PIN.branch, "codex/unified-local-20260907");
  assert.equal(PIN.sha, "c9b04e89577a40f17c71564926eed89ad53faa98");
  assert.match(PIN.url, /\/pull\/23$/);
  assert.equal(PIN.siblingSkeleton.pull, 22);
});

test("staging origin and public health paths match the published worker", () => {
  assert.equal(STAGING.origin, "https://project-room-staging.getdasha.workers.dev");
  assert.equal(STAGING.healthPath, "/api/health");
  assert.equal(STAGING.readyPath, "/api/ready");
  assert.equal(STAGING.bareHealthPath, "/health");
  assert.equal(STAGING.observed.health.status, 200);
  assert.equal(STAGING.observed.health.body.mode, "cloudflare-staging");
  assert.equal(STAGING.observed.ready.status, 200);
  assert.equal(STAGING.observed.bareHealth.status, 404);
  assert.equal(STAGING.observed.bareHealth.body.error.code, "not_found");
});

test("matrix names the five hosted-denial rows", () => {
  assert.deepEqual(MATRIX_IDS, [
    "cancelled",
    "expired",
    "join-cap",
    "removed-member",
    "signed-out-401"
  ]);
  for (const row of MATRIX) {
    assert.ok(row.expected);
    assert.ok(row.copy);
    assert.ok(row.local);
    assert.ok(row.hostedCheck);
    assert.match(row.security, /not |Do not |never |stay /i);
  }
});

test("hosted-check gap lists join/return coverage and denial holes", () => {
  assert.equal(HOSTED_CHECK_GAP.path, "cloudflare/hosted-check.mjs");
  assert.equal(HOSTED_CHECK_GAP.pinSha, PIN.sha);
  assert.ok(HOSTED_CHECK_GAP.covers.some((item) => /guest join/i.test(item)));
  assert.ok(HOSTED_CHECK_GAP.covers.some((item) => /--return/.test(item)));
  assert.deepEqual(
    [...HOSTED_CHECK_GAP.missing].sort(),
    [
      "cancelled link denial on the hosted origin",
      "expired link denial on the hosted origin",
      "join-cap / full link denial on the hosted origin",
      "removed-member denial on the hosted origin",
      "signed-out 401 room-read denial as a repeatable hosted-check case"
    ].sort()
  );
});

test("matrix report cites the pin SHA and hosted-check gap", () => {
  const report = matrixReport();
  assert.equal(report.pin, "c9b04e89577a40f17c71564926eed89ad53faa98");
  assert.equal(report.pull, 23);
  assert.equal(report.staging, STAGING.origin);
  assert.equal(report.rows.length, 5);
  assert.ok(report.gap.includes(HOSTED_CHECK_GAP.missing[0]));
  assert.equal(DENIAL_CONTRACTS.cancelled.code, "link_unavailable");
});
