import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaimArbitrationError,
  MINUTE_MS,
  arbitrateClaims,
  minuteBucketMs,
  rankClaims,
} from "../server/claim-arbitration.mjs";

// FIX-52: deterministic claim-arbitration rule beyond earliest-timestamp.
// Fail-first: these fail before the implementation exists (no module, no
// exports). The rule: earliest minute-bucket wins; ties inside the same
// minute break on lexicographic claim-id order. Pure: no randomness, no
// wall-clock reads — same input set always yields the same winner,
// regardless of input order or process.

// Deterministic shuffle (LCG) so the order-invariance property tests are
// themselves reproducible; Math.random would make failures unrepeatable.
function seededShuffle(items, seed) {
  const arr = items.slice();
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const T0 = Date.parse("2026-10-09T16:00:00.000Z");

const claim = (id, atMs) => ({ id, claimedAt: new Date(atMs).toISOString() });

test("earliest minute bucket wins, regardless of input order", () => {
  const claims = [
    claim("lane-c", T0 + 5 * 60_000),
    claim("lane-a", T0 + 2 * 60_000),
    claim("lane-b", T0 + 9 * 60_000),
  ];
  assert.equal(arbitrateClaims(claims).id, "lane-a");
  assert.equal(arbitrateClaims(seededShuffle(claims, 7)).id, "lane-a");
  assert.equal(arbitrateClaims([claims[2], claims[0], claims[1]]).id, "lane-a");
});

test("same-minute tie-break: lexicographically smallest claim id wins", () => {
  const claims = [
    claim("lane-zulu", T0 + 41_000),
    claim("lane-alpha", T0 + 3_000),
    claim("lane-mike", T0 + 59_000),
    claim("lane-bravo", T0 + 0),
  ];
  // All four land in the same minute bucket; ms offsets must not matter.
  for (let seed = 1; seed <= 25; seed += 1) {
    const winner = arbitrateClaims(seededShuffle(claims, seed));
    assert.equal(winner.id, "lane-alpha", `seed ${seed}`);
  }
});

test("exact-minute boundary: 11:59:59.999 and 12:00:00.000 are different buckets", () => {
  const justBefore = { id: "z-last", claimedAt: "2026-10-09T11:59:59.999Z" };
  const onTheMinute = { id: "a-first", claimedAt: "2026-10-09T12:00:00.000Z" };
  assert.equal(minuteBucketMs(justBefore.claimedAt), minuteBucketMs(onTheMinute.claimedAt) - 1);
  assert.equal(arbitrateClaims([onTheMinute, justBefore]).id, "z-last");
  // Same bucket through 59.999s: id tie-break decides, not ms offset.
  const late = { id: "b-late", claimedAt: "2026-10-09T12:00:59.999Z" };
  assert.equal(minuteBucketMs(late.claimedAt), minuteBucketMs(onTheMinute.claimedAt));
  assert.equal(arbitrateClaims([late, onTheMinute]).id, "a-first");
});

test("property: input-order invariance over many shuffles", () => {
  const claims = [];
  for (let i = 0; i < 12; i += 1) {
    // Mix: several claims share minute buckets, spread across minutes.
    claims.push(claim(`lane-${String(i).padStart(2, "0")}`, T0 + (i % 4) * 60_000 + i * 1_234));
  }
  const expected = arbitrateClaims(claims).id;
  for (let seed = 1; seed <= 60; seed += 1) {
    assert.equal(arbitrateClaims(seededShuffle(claims, seed)).id, expected, `seed ${seed}`);
  }
});

test("property: never two winners; ranking covers the input set exactly once", () => {
  const claims = [
    claim("c", T0 + 60_000),
    claim("a", T0 + 60_000 + 500),
    claim("b", T0),
  ];
  const winner = arbitrateClaims(claims);
  const ranked = rankClaims(claims);
  assert.equal(ranked.length, claims.length);
  assert.deepEqual(ranked.map(r => r.id).sort(), ["a", "b", "c"]);
  assert.equal(ranked[0].id, winner.id);
  assert.equal(winner.id, "b"); // earliest minute, before the same-minute pair
  // The same-minute pair orders by id, not by ms.
  assert.deepEqual(ranked.slice(1).map(r => r.id), ["a", "c"]);
});

test("property: cross-run determinism (200 repeats, same winner)", () => {
  const claims = [
    claim("lane-9", T0 + 17_000),
    claim("lane-2", T0 + 3 * 60_000 + 5_000),
    claim("lane-7", T0 + 44_000),
  ];
  const first = arbitrateClaims(claims).id;
  for (let i = 0; i < 200; i += 1) {
    assert.equal(arbitrateClaims(claims).id, first);
  }
});

test("accepts ISO strings, epoch-ms numbers, and Date instances", () => {
  const at = T0 + 5_000;
  const mixed = [
    { id: "iso", claimedAt: new Date(at).toISOString() },
    { id: "num", claimedAt: at },
    { id: "date", claimedAt: new Date(at) },
  ];
  // All three are the same instant: the id tie-break decides among them.
  assert.equal(arbitrateClaims(mixed).id, "date");
  assert.equal(minuteBucketMs(at), Math.floor(T0 / MINUTE_MS));
});

test("outputs are frozen", () => {
  const claims = [claim("a", T0), claim("b", T0 + 60_000)];
  const winner = arbitrateClaims(claims);
  const ranked = rankClaims(claims);
  assert.ok(Object.isFrozen(winner));
  assert.ok(Object.isFrozen(ranked));
  assert.ok(ranked.every(r => Object.isFrozen(r)));
});

test("rejects empty and malformed input with a named error", () => {
  assert.throws(() => arbitrateClaims([]), ClaimArbitrationError);
  assert.throws(() => arbitrateClaims("nope"), ClaimArbitrationError);
  assert.throws(() => arbitrateClaims([{ id: "", claimedAt: T0 }]), ClaimArbitrationError);
  assert.throws(() => arbitrateClaims([{ id: "x" }]), ClaimArbitrationError);
  assert.throws(() => arbitrateClaims([{ id: "x", claimedAt: "not-a-time" }]), ClaimArbitrationError);
  assert.throws(() => arbitrateClaims([{ id: "x", claimedAt: NaN }]), ClaimArbitrationError);
  assert.throws(() => rankClaims([null]), ClaimArbitrationError);
});

test("single claim always wins", () => {
  const only = claim("solo", T0 + 123);
  assert.equal(arbitrateClaims([only]).id, "solo");
});
