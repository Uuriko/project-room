// Pure replay-guard checks: no Durable Object, no clock. The harness test in
// relay.check.mjs covers an immediate verbatim replay end to end; these cover
// the pruning lifecycle the harness cannot reach without waiting out the
// skew window — in particular a request whose timestamp sits in the future
// relative to the relay clock (the HMAC check allows +/- HMAC_SKEW_SEC).
import test from "node:test";
import assert from "node:assert/strict";
import { assertFreshControlSignature } from "../src/replay-guard.mjs";
import { HMAC_SKEW_SEC } from "../src/protocol.mjs";

const WINDOW = HMAC_SKEW_SEC + 60;

const replayed = error => error?.code === "replay_rejected" && error?.status === 409;

test("a signature honored once is rejected on immediate replay", () => {
  const now = 1_000_000;
  let seen = assertFreshControlSignature([], "sig-a", now, WINDOW, now);
  assert.throws(() => assertFreshControlSignature(seen, "sig-a", now, WINDOW, now), replayed);
});

test("a future-dated signature cannot be replayed while its HMAC still verifies", () => {
  // The signer and the relay disagree by 200s of clock skew: the stamp is
  // 200s in the future, inside the HMAC window, so the first use is honored.
  // A verbatim replay 200s after the stamp still verifies (|T2 - S| <= 300),
  // so the guard must remember the signature — pruning on server receipt
  // time would already have forgotten it. Fails pre-fix (replay accepted).
  const receivedAt = 1_000_000;
  const stamp = receivedAt + 200;
  let seen = assertFreshControlSignature([], "sig-b", receivedAt, WINDOW, stamp);
  const replayAt = stamp + 200;
  assert.ok(Math.abs(replayAt - stamp) <= HMAC_SKEW_SEC, "replay must still pass the HMAC window");
  assert.throws(
    () => assertFreshControlSignature(seen, "sig-b", replayAt, WINDOW, stamp),
    replayed,
    "replay inside the HMAC window must die even when the stamp is future-dated",
  );
});

test("a signature is forgotten only after its HMAC can no longer verify", () => {
  const receivedAt = 1_000_000;
  const stamp = receivedAt + 200;
  let seen = assertFreshControlSignature([], "sig-c", receivedAt, WINDOW, stamp);
  // Past stamp + skew the HMAC itself fails, so the record may be pruned.
  const longAfter = stamp + HMAC_SKEW_SEC + 61;
  seen = assertFreshControlSignature(seen, "sig-d", longAfter, WINDOW, longAfter - HMAC_SKEW_SEC);
  assert.ok(!seen.some(row => row.signature === "sig-c"), "expired record is pruned");
});

test("distinct signatures do not collide and malformed rows are ignored", () => {
  const now = 1_000_000;
  let seen = assertFreshControlSignature([], "sig-e", now, WINDOW, now);
  seen = assertFreshControlSignature(seen, "sig-f", now, WINDOW, now);
  assert.equal(seen.length, 2);
  seen = assertFreshControlSignature([null, { signature: 42 }, { at: now }, ...seen], "sig-g", now, WINDOW, now);
  assert.ok(seen.some(row => row.signature === "sig-g"));
  assert.throws(() => assertFreshControlSignature(seen, "sig-e", now, WINDOW, now), replayed);
});

test("a non-integer stamp fails closed to receipt time, never to an unprunable row", () => {
  const now = 1_000_000;
  const seen = assertFreshControlSignature([], "sig-h", now, WINDOW, Number.NaN);
  for (const row of seen) assert.ok(Number.isSafeInteger(row.at), "stored rows stay prunable");
  assert.throws(() => assertFreshControlSignature(seen, "sig-h", now, WINDOW, Number.NaN), replayed);
});
