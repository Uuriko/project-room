// R7 — duplicate rule drift parity: the same validation rule is defined in
// multiple modules. The copies agree today; this test is the tripwire that
// fires when one copy is edited without the others, so a claim valid in one
// layer can never be rejected by another.
//
// Gate answers: (1) protects the cross-module accept/reject contract of six
// validation rules; (2) credible regression is a one-copy pattern edit
// (tightening LANE_RE in one file, "fixing" \d to [0-9] in another); (3) no
// existing test covers cross-copy agreement (tests/claim-validate.test.js
// covers claim-validate <-> scripts/room only); (4) the only seam is an
// additive `export` on existing consts plus an import-safe main() guard on
// scripts/claims-index.mjs — no behavior change.
import test from "node:test";
import assert from "node:assert/strict";

import {
  TASK_ID_RE as validateTaskIdRe,
  LEASE_RE as validateLeaseRe,
  STATE_RE as validateStateRe,
} from "../server/claim-validate.mjs";
import {
  TASK_ID_RE as indexTaskIdRe,
  LEASE_RE as indexLeaseRe,
  STATE_RE as indexStateRe,
} from "../scripts/claims-index.mjs";

// Behavioral fingerprint: accept/reject plus the full exec match (capture
// groups matter — LEASE_RE's group is the parsed hour count).
const fingerprint = (re, s) => {
  const m = new RegExp(re.source, re.flags).exec(s);
  return m ? JSON.stringify([...m]) : null;
};

function checkParity(name, copies, accepts, rejects) {
  for (const s of accepts) {
    const fps = copies.map(re => fingerprint(re, s));
    assert.ok(fps.every(fp => fp !== null), `${name}: all copies must accept ${JSON.stringify(s)} (got ${fps})`);
    assert.ok(fps.every(fp => fp === fps[0]), `${name}: all copies must match identically on ${JSON.stringify(s)} (got ${fps})`);
  }
  for (const s of rejects) {
    const fps = copies.map(re => fingerprint(re, s));
    assert.ok(fps.every(fp => fp === null), `${name}: all copies must reject ${JSON.stringify(s)} (got ${fps})`);
  }
}

test("TASK_ID_RE parity: claim-validate, claims-index", () => {
  checkParity("TASK_ID_RE",
    [validateTaskIdRe, indexTaskIdRe],
    ["RC-2026-09-29-1", "RC-2026-09-29-12345", "RC-2000-01-01-999"],
    ["RC-2026-9-29-1", "RC-2026-09-29-", "rc-2026-09-29-1", "RC-2026-09-29-1 ",
     "RC-2026-09-29", "RC-2026-13-99-1x", "", "RC-2026-09-29-１２３"]);
});

test("LEASE_RE parity: claim-validate, claims-index", () => {
  checkParity("LEASE_RE",
    [validateLeaseRe, indexLeaseRe],
    ["lease=6h", "lease=0h", "lease=123h"],
    ["lease=6H", "lease=6", "6h", "lease= 6h", "lease=-1h", "lease=6hh", ""]);
  // The capture group is the contract: every copy must parse the same hours.
  for (const re of [validateLeaseRe, indexLeaseRe]) {
    assert.equal(new RegExp(re.source, re.flags).exec("lease=42h")[1], "42");
  }
});

test("STATE_RE parity: claim-validate, claims-index", () => {
  checkParity("STATE_RE",
    [validateStateRe, indexStateRe],
    ["submitted", "working", "cancelled", "suspended", "completed", "failed(abc_123)"],
    ["failed()", "failed(a-b)", "failed(a b)", "done", "WORKING", "", "failed"]);
});
