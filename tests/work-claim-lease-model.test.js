// Lease-model contracts: createdSeq from the server-side journal (the
// provisional-claim + seq-confirmation grant flow), epoch fencing against
// stale writers, and unknown-field passthrough at the route boundary
// (production rows carry fields this checkout doesn't know).
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function roomFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-holder", type: "member.added",
    data: { memberId: "holder", displayName: "holder", kind: "agent", permissions: ["accept_work", "complete_work"] },
  });
  t.after(() => store.close());
  const call = async (memberId, route, { id = null, body = undefined } = {}) => {
    const method = body === undefined ? "GET" : "POST";
    try {
      const out = await handleWorkClaims({
        req: { method, body },
        res: {},
        url: new URL("https://room.example/api/rooms/commons/work-claims"),
        store, roomId: "commons",
        auth: { member: { id: memberId, kind: "agent", permissions: [] } },
        workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
      });
      return { status: out.status, value: out.value, code: out.value?.error?.code ?? null };
    } catch (error) {
      if (!Number.isInteger(error.status)) throw error;
      return { status: error.status, code: error.code, message: error.message };
    }
  };
  return { store, call };
}

test("createdSeq comes from the server-side journal sequence on create", async t => {
  const { store, call } = roomFixture(t);
  const before = store.room("commons").sequence;
  const out = await call("owner", "create", { body: { id: "seq1", files: ["src/seq1.mjs"] } });
  assert.equal(out.status, 201);
  // The create event advanced the journal; createdSeq is that event's sequence.
  const after = store.room("commons").sequence;
  assert.ok(after > before);
  assert.equal(out.value.createdSeq, after);
  // And it survives a read.
  const read = await call("owner", "read", { id: "seq1" });
  assert.equal(read.value.createdSeq, after);
});

test("epoch fencing: a mutation carrying a stale epoch is 409 stale_epoch", async t => {
  const { call } = roomFixture(t);
  await call("owner", "create", { body: { id: "ep1", files: ["src/ep1.mjs"] } });
  await call("holder", "claim", { id: "ep1", body: {} });
  const item = await call("owner", "read", { id: "ep1" });
  assert.equal(item.value.epoch, 1);
  // Simulate the reaper bumping the epoch (a reap happened elsewhere).
  // The holder's next mutation with the old epoch must be refused.
  const stale = await call("holder", "update", { id: "ep1", body: { note: "stale write", epoch: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "stale_epoch");
  // The current epoch is accepted.
  const fresh = await call("holder", "update", { id: "ep1", body: { note: "fresh write", epoch: 1 } });
  assert.equal(fresh.status, 200);
});

test("unknown fields pass through the route verbatim (schema drift)", async t => {
  const { call } = roomFixture(t);
  const out = await call("owner", "create", {
    // B4: squadId became a known, validated field on the base after B1's
    // branch point, so the drift probe uses a field this checkout truly
    // does not know.
    body: { id: "drift1", files: ["src/drift1.mjs"], futureField: "future-1", parentClaimId: "p1", readingAcks: ["m1"] },
  });
  assert.equal(out.status, 201);
  const read = await call("owner", "read", { id: "drift1" });
  assert.equal(read.value.futureField, "future-1");
  assert.equal(read.value.parentClaimId, "p1");
  assert.deepEqual(read.value.readingAcks, ["m1"]);
  // Unknown fields survive a claim round too.
  await call("holder", "claim", { id: "drift1", body: {} });
  const reread = await call("owner", "read", { id: "drift1" });
  assert.equal(reread.value.futureField, "future-1");
});
