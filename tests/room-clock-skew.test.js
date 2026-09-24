import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

// Exercises the clock-skew guard via the _clock test verb:
//   _clock [--op EPOCH] [--ref EPOCH] [--date "Date: ..."]
// --op simulates the operator clock (ROOM_CLOCK_OP seam), --ref supplies the
// board reference, --date parses an HTTP Date header into the reference.
// Regression coverage for the PR #810 audit finding: the old clock_now read
// the local clock twice, so |skew| was always 0 and the >300s correction
// branch was dead code — a +2h operator clock posted premature strikes and a
// -2h clock silently delayed enforcement.
function clock(args) {
  const res = spawnSync(room, ["_clock", ...args], { encoding: "utf8", timeout: 30000 });
  return {
    status: res.status,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

const OP = 1790207000; // fixed simulated operator clock
const REF = 1790207000; // fixed simulated board reference

test("no skew: returns the operator clock with no warning", () => {
  const r = clock(["--op", String(OP), "--ref", String(REF)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, String(OP));
  assert.equal(r.stderr, "");
});

test("no reference: falls back to the operator clock", () => {
  const r = clock(["--op", String(OP)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, String(OP));
});

test("operator clock 2h ahead: warns and uses board time (never strikes early)", () => {
  const r = clock(["--op", String(OP + 7200), "--ref", String(REF)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, String(REF), "ahead clock must not drive lease math");
  assert.match(r.stderr, /ahead of board time/);
});

test("operator clock 2h behind: warns and uses board time (never silently delays)", () => {
  const r = clock(["--op", String(OP - 7200), "--ref", String(REF)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, String(REF), "behind clock must not drive lease math");
  assert.match(r.stderr, /behind board time/);
});

test("skew within 5 minutes: no correction, no warning", () => {
  for (const skew of [100, -100, 300, -300]) {
    const r = clock(["--op", String(OP + skew), "--ref", String(REF)]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, String(OP + skew), `skew=${skew}`);
    assert.equal(r.stderr, "", `skew=${skew}`);
  }
});

test("skew just over 5 minutes: corrects", () => {
  for (const skew of [301, -301]) {
    const r = clock(["--op", String(OP + skew), "--ref", String(REF)]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, String(REF), `skew=${skew}`);
    assert.match(r.stderr, /clock skew/);
  }
});

test("--date parses a valid HTTP Date header into the reference", () => {
  // 2026-09-23T23:49:42Z; op == ref so no correction fires.
  const r = clock(["--op", "1790207382", "--date", "Date: Wed, 23 Sep 2026 23:49:42 GMT"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1790207382");
});

test("--date accepts a bare value and a lowercase header name", () => {
  for (const hdr of ["Wed, 23 Sep 2026 23:49:42 GMT", "date: Wed, 23 Sep 2026 23:49:42 GMT"]) {
    const r = clock(["--op", "1790207382", "--date", hdr]);
    assert.equal(r.status, 0, hdr);
    assert.equal(r.stdout, "1790207382", hdr);
  }
});

test("--date with a garbage header fails loudly", () => {
  const r = clock(["--date", "Date: not a date"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unparseable Date header/);
});

test("--date with an impossible month fails loudly", () => {
  const r = clock(["--date", "Date: Wed, 23 Xyz 2026 23:49:42 GMT"]);
  assert.notEqual(r.status, 0);
});
