// Fail-first regression (guild-06 WAVE-1000 re-verify, 2026-10-09).
//
// E5/D4 (QA-200): POST /work-claims/:id/release must bind the claim round —
// a release prepared against a stale round must fail 409 work_claim_conflict,
// not silently release the newer round. scripts/agent-inbox.mjs (feed63746)
// and scripts/qa3/authz-board.mjs (6146ae702) claim this binding, but the
// chain is broken in two places:
//   (a) client workRelease/releaseWorkItem drops expectedClaimedAt /
//       expectedHistoryLength before HTTP (client/room-agent.mjs:854,878), and
//   (b) the server release route accepts only {note?, reason?} (strict shape,
//       server/work-claim-routes.mjs:1201) and performs no round comparison —
//       so the qa3 harness's release action 422s outright.
// Both tests fail until the chain is complete (client passes the fields
// through AND the server honors them with 409-on-stale).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const token = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { store, origin, token, owner: new RoomAgentClient({ origin, roomId: "commons", token }) };
}

async function postRelease(origin, token, id, body) {
  const res = await fetch(`${origin}/api/rooms/commons/work-claims/${id}/release`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("stale-round release is rejected with 409 work_claim_conflict", async t => {
  const { owner, token, origin } = await fixture(t);
  await owner.workClaim("stale-release", { leaseHours: 1 });
  const round = await owner.workClaimGet("stale-release");
  const staleAt = round.claimedAt;
  const staleLen = round.history.length;
  await owner.updateWorkItem("stale-release", { note: "round moves on" });
  const moved = await owner.workClaimGet("stale-release");
  assert.ok(moved.history.length > staleLen, "test setup: round must advance");
  const r = await postRelease(origin, token, "stale-release", {
    note: "stale retry",
    expectedClaimedAt: staleAt,
    expectedHistoryLength: staleLen,
  });
  assert.equal(r.status, 409, `stale release must not succeed (got ${r.status})`);
  assert.equal(r.json?.code, "work_claim_conflict");
});

test("fresh-round release still succeeds with 200", async t => {
  const { owner, token, origin } = await fixture(t);
  await owner.workClaim("fresh-release", { leaseHours: 1 });
  const round = await owner.workClaimGet("fresh-release");
  const r = await postRelease(origin, token, "fresh-release", {
    note: "fresh",
    expectedClaimedAt: round.claimedAt,
    expectedHistoryLength: round.history.length,
  });
  assert.equal(r.status, 200, `fresh release must succeed (got ${r.status})`);
});

test("SDK workRelease sends the round preconditions on the wire", async t => {
  const { origin } = await fixture(t);
  const seen = [];
  const probe = new RoomAgentClient({
    origin,
    roomId: "commons",
    token: "a".repeat(43),
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await probe.workRelease("x", {
    note: "n",
    expectedClaimedAt: "2026-10-09T00:00:00.000Z",
    expectedHistoryLength: 2,
  });
  assert.equal(seen[0].expectedClaimedAt, "2026-10-09T00:00:00.000Z");
  assert.equal(seen[0].expectedHistoryLength, 2);
});
