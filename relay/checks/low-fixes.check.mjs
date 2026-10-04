// Regression checks for the 2026-10-03 relay/machine LOW findings (L-1, L-2, L-4).
// L-3 and L-5 are covered in machine/test/machine.test.mjs; L-6 (a TTL value)
// is documented in relay/PROTOCOL.md rather than asserted as a flag.

import assert from "node:assert/strict";
import test from "node:test";
import {
  control, mint, readBody, relayFetch, signControl, startRelay,
} from "./harness.mjs";
import {
  IDENTITY_CACHE_MS, REVOKE_PER_CALL_MAX, REVOKE_TOTAL_MAX, mergeRevoked,
} from "../src/protocol.mjs";

// Post a pre-signed control message verbatim (same signature twice), for
// replay tests. control() re-signs on every call, which is not a replay.
async function postSignedControl(ctx, machineId, action, signed) {
  const response = await relayFetch(ctx, `/v0/machines/${machineId}/${action}`, {
    method: "POST",
    raw: signed.raw,
    headers: {
      "x-relay-timestamp": signed.timestamp,
      "x-relay-signature": signed.signature,
    },
  });
  return readBody(response);
}

async function mintMachine(ctx) {
  const minted = await mint(ctx, {
    label: "spare", roomId: "commons", ownerMemberId: "owner", inviteCode: "RM-0123456789ABCDEF",
  });
  assert.equal(minted.status, 201);
  return minted.body.machineId;
}

// L-1: control endpoints must verify the signature before the machine-exists
// check, so an unauthenticated caller cannot tell existing machines (401)
// from missing ones (404).
test("L-1: unauthenticated control gets 401 whether the machine exists or not", async () => {
  const ctx = await startRelay();
  try {
    const machineId = await mintMachine(ctx);
    const unknown = "mch_0000000000000000";
    const bad = {
      raw: "{}",
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: "0".repeat(64),
    };
    const headers = { "x-relay-timestamp": bad.timestamp, "x-relay-signature": bad.signature };
    const post = async (id) => {
      const response = await relayFetch(ctx, `/v0/machines/${id}/halt`, {
        method: "POST", raw: bad.raw, headers,
      });
      return readBody(response);
    };
    const missUnknown = await post(unknown);
    assert.equal(missUnknown.status, 401);
    const missReal = await post(machineId);
    assert.equal(missReal.status, 401);
    // A correctly signed request still gets the honest 404 for a missing machine.
    const authed = await postSignedControl(ctx, unknown, "halt", signControl(ctx, {}));
    assert.equal(authed.status, 404);
    assert.equal(authed.body.error.code, "machine_unknown");
  } finally {
    await ctx.dispose();
  }
});

// L-2: the replay guard records a signature only after the control is
// accepted. A control that fails validation stays retryable: the operator's
// same-second retry must be re-evaluated (422 again), not 409.
test("L-2: a rejected control is retryable with the same signature", async () => {
  const ctx = await startRelay();
  try {
    const machineId = await mintMachine(ctx);
    const signed = signControl(ctx, { minutes: 99999 });
    const first = await postSignedControl(ctx, machineId, "pause", signed);
    assert.equal(first.status, 422);
    assert.equal(first.body.error.code, "invalid_pause");
    const retry = await postSignedControl(ctx, machineId, "pause", signed);
    assert.equal(retry.status, 422);
    assert.equal(retry.body.error.code, "invalid_pause");
  } finally {
    await ctx.dispose();
  }
});

// L-2 (positive): an accepted control still records its signature — the
// identical message replayed verbatim is refused as a replay.
test("L-2: an accepted control records its signature for replay detection", async () => {
  const ctx = await startRelay();
  try {
    const machineId = await mintMachine(ctx);
    const signed = signControl(ctx, {});
    const first = await postSignedControl(ctx, machineId, "halt", signed);
    assert.equal(first.status, 200);
    const replay = await postSignedControl(ctx, machineId, "halt", signed);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, "replay_detected");
  } finally {
    await ctx.dispose();
  }
});

// L-4: the halt revoke list is bounded per call and in total, and expired
// entries are pruned. mergeRevoked is the pure helper applyControl() uses.
test("L-4: mergeRevoked caps intake per call and total stored", () => {
  const now = 1_700_000_000;
  const items = Array.from({ length: 200 }, (_, i) => ({ jti: `jti-${i}`, exp: now + 900 }));
  const merged = mergeRevoked([], items, now);
  assert.equal(merged.length, REVOKE_PER_CALL_MAX);
  assert.deepEqual(merged.map(row => row.jti), items.slice(0, REVOKE_PER_CALL_MAX).map(item => item.jti));

  const full = Array.from({ length: REVOKE_TOTAL_MAX }, (_, i) => ({ jti: `old-${i}`, exp: now + 900 }));
  const overflow = mergeRevoked(full, [{ jti: "new-1", exp: now + 900 }], now);
  assert.equal(overflow.length, REVOKE_TOTAL_MAX);
  assert.equal(overflow[overflow.length - 1].jti, "new-1");

  const withExpired = [{ jti: "dead", exp: now - 10 }, { jti: "live", exp: now + 900 }];
  const pruned = mergeRevoked(withExpired, [], now);
  assert.deepEqual(pruned.map(row => row.jti), ["live"]);

  // Re-listing a jti moves it to the end with the new expiry.
  const moved = mergeRevoked([{ jti: "a", exp: now + 100 }, { jti: "b", exp: now + 100 }], [{ jti: "a", exp: now + 500 }], now);
  assert.deepEqual(moved.map(row => row.jti), ["b", "a"]);
  assert.equal(moved[1].exp, now + 500);

  // Malformed entries are skipped, not stored.
  const dirty = mergeRevoked([], [null, {}, { jti: "" }, { jti: "x".repeat(129) }, { jti: "ok", exp: now + 10 }], now);
  assert.deepEqual(dirty.map(row => row.jti), ["ok"]);
});

// L-4: the documented caps are the values the doc promises.
test("L-4: revoke caps match relay/PROTOCOL.md", () => {
  assert.equal(REVOKE_PER_CALL_MAX, 64);
  assert.equal(REVOKE_TOTAL_MAX, 512);
});

// L-6: the passthrough identity cache window is documented, not 5 minutes.
test("L-6: identity cache window is one minute", () => {
  assert.equal(IDENTITY_CACHE_MS, 60 * 1000);
});
