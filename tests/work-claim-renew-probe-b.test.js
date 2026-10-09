// QA200-MUT-04B hardening, rewritten for the FIX-11 decided semantics
// (2026-10-09, WAVE-300 ranked-fixes burn-down).
//
// Footgun fixed: "renew extends from NOW instead of from the current lease
// expiry (shortening an unexpired lease)". renewWork now extends from the
// OLD EXPIRY and preserves the original lease duration when no explicit
// leaseHours is given. The new lease window slides forward: leaseStartAt
// becomes the old expiry, so each renewal's progress message must be newer
// than the previous expiry — proof of progress per renewal window.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, renewWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

test("MUT-04B: renew extends from the old expiry — a smaller renewal duration stacks, never shortens", () => {
  const claimed = claimWork({ id: "wB" }, "quill", { leaseHours: 6, now: T0 }); // expires T0+6h
  const renewed = renewWork(claimed, "quill", { leaseHours: 1, now: T0 + 2 * H }); // +2h in, 4h left
  // Extend from expiry: new window is [T0+6h, T0+7h]. The remaining 4h of the
  // old lease are preserved, not discarded — the renewal stacks on top.
  assert.equal(renewed.leaseStartAt, iso(T0 + 6 * H));
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 7 * H));
});

test("MUT-04B: renew with no explicit duration preserves the original lease duration", () => {
  const claimed = claimWork({ id: "wB2" }, "quill", { leaseHours: 6, now: T0 }); // expires T0+6h
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H }); // no leaseHours
  // No silent upgrade to the room default: the original 6h duration carries over.
  assert.equal(renewed.leaseStartAt, iso(T0 + 6 * H));
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 12 * H));
});
