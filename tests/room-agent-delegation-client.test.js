import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";

// G-H1 regression (RC-2026-09-30-3624).
//
// Contract: the owner-granted membership-administration client methods must
// deliver a real AbortSignal to the transport. These three methods passed
// `{ signal }` (a plain options object) as the positional `signal` argument
// to `#fetchPath`, so `#fetchRaw` called `AbortSignal.any` on a non-signal
// and every call threw TypeError before any HTTP happened — the entire
// client surface for membership administration was dead.
//
// Credible regression: reverting the three call sites to `{ signal }`
// re-throws TypeError from AbortSignal.any (verified against the pre-fix
// code with the same probe shape).
//
// Why new coverage: tests/membership-delegation.test.js covers the server
// store routes; it cannot reach the client's transport-layer signal
// plumbing. No production seams: the client's own fetchImpl injection
// boundary is used, with a strict stub (records options, returns a minimal
// valid response).
function stubClient(seen) {
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };
  return new RoomAgentClient({ origin: "http://127.0.0.1:1", roomId: "commons", token: "a".repeat(43), fetchImpl });
}

test("membership-administration methods deliver a real AbortSignal to the transport", async () => {
  const seen = [];
  const client = stubClient(seen);
  const signal = AbortSignal.timeout(5000);
  await client.membershipAdministrationGrants({ signal });
  await client.grantMembershipAdministration("ai_delegate", { signal });
  await client.revokeMembershipAdministration("ai_delegate", { signal });
  assert.equal(seen.length, 3);
  assert.match(seen[0].url, /membership-delegation$/);
  assert.match(seen[1].url, /membership-delegation\/grant$/);
  assert.match(seen[2].url, /membership-delegation\/revoke$/);
  for (const { options } of seen) {
    assert.ok(options.signal instanceof AbortSignal, "transport received an AbortSignal, not an options object");
  }
});

test("membership-administration calls work without a caller signal too", async () => {
  const seen = [];
  const client = stubClient(seen);
  await client.membershipAdministrationGrants();
  assert.equal(seen.length, 1);
  assert.ok(seen[0].options.signal instanceof AbortSignal, "the 15s deadline signal is still applied");
});
