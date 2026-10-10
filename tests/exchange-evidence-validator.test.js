// Dispute evidence validator tests — hard task 107.
// 10 sample bundles: 2 accepted, 7 rejected, 1 accepted-with-warning.
import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceBundle } from "../scripts/exchange/evidence-validator.mjs";

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const FUNDED = Date.parse("2026-10-01T00:00:00.000Z");
const iso = t => new Date(t).toISOString();
const HASH = "a".repeat(64);

const bundle = (over = {}) => ({
  bundleVersion: "dispute-evidence/1",
  bountyId: "b1",
  submittedBy: "alice",
  submittedAt: iso(T0),
  claim: "work.completed",
  items: [{
    kind: "artifact-link", uri: "https://github.com/Uuriko/project-room/pull/1836",
    sha256: HASH, capturedAt: iso(T0 - 86400_000), note: "the merged PR implementing the bounty",
  }],
  signature: { signer: "alice", sig: "b".repeat(128) },
  ...over,
});
const check = (b, ctx = {}) => validateEvidenceBundle(b, { fundedAt: FUNDED, now: T0, ...ctx });

test("1. valid completion bundle is accepted", () => {
  const r = check(bundle());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});

test("2. valid non-completion bundle is accepted", () => {
  const r = check(bundle({
    claim: "work.not_completed",
    submittedBy: "sponsor1",
    signature: { signer: "sponsor1", sig: "b".repeat(128) },
    items: [{ kind: "log-excerpt", uri: "room://logs/ci", sha256: HASH, capturedAt: iso(T0 - 3600_000), note: "CI never went green on the submission" }],
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("3. missing signature is rejected", () => {
  const b = bundle(); delete b.signature;
  const r = check(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "missing_signature"));
});

test("4. future submittedAt is rejected", () => {
  const r = check(bundle({ submittedAt: iso(T0 + 3600_000) }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "future_timestamp"));
});

test("5. evidence captured before funding is inadmissible", () => {
  const b = bundle();
  b.items[0].capturedAt = iso(FUNDED - 86400_000);
  const r = check(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "predates_bounty"));
});

test("6. artifact-link without sha256 is rejected (bytes could be swapped)", () => {
  const b = bundle();
  delete b.items[0].sha256;
  const r = check(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "missing_hash"));
});

test("7. empty items is rejected", () => {
  const r = check(bundle({ items: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "empty_items"));
});

test("8. unknown item kind is rejected", () => {
  const b = bundle();
  b.items[0].kind = "vibes";
  const r = check(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "bad_kind"));
});

test("9. claim without a supporting item kind is rejected", () => {
  const b = bundle({ claim: "payment.owed" });
  b.items[0].kind = "artifact-link"; // payment.owed needs message-ref or attestation
  const r = check(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === "unsupported_claim"));
});

test("10. stale evidence warns but passes", () => {
  const b = bundle();
  b.items[0].capturedAt = iso(T0 - 31 * 86400_000);
  const r = check(b, { fundedAt: T0 - 60 * 86400_000 }); // old, but after funding
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some(w => w.code === "stale_evidence"));
});
