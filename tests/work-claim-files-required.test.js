// Collide-guild addendum: files are required at claim creation. Two claims
// on the same work, neither declaring files, used to both 200 and both
// believe they succeeded — a silent collision. The create path now refuses
// file-less claims (422 files_required) unless the room opts out via
// workClaims.requireClaimFiles:false (then filesDeclared:false marks the
// claim so the arbiter can see it).
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: {
    roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
    room: () => ({ sequence: 1, state: { messages: [] } }),
  },
  roomId: "room1",
  auth: { member: { ...MEMBERS[memberId], id: memberId } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

test("create without files is 422 files_required and stores nothing", async () => {
  const registry = createWorkClaimRegistry();
  await assert.rejects(call(registry, "owner", "create", null, { id: "nofiles", title: "t" }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "files_required");
    return true;
  });
  assert.equal(registry.has("room1", "nofiles"), false);
  // An empty array is the same as absent.
  await assert.rejects(call(registry, "owner", "create", null, { id: "empty", files: [] }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "files_required");
    return true;
  });
});

test("create with files is 201 and marks filesDeclared:true", async () => {
  const registry = createWorkClaimRegistry();
  const out = await call(registry, "owner", "create", null, { id: "f1", files: ["src/a.mjs"] });
  assert.equal(out.status, 201);
  assert.equal(out.value.filesDeclared, true);
  assert.deepEqual(out.value.files, ["src/a.mjs"]);
});

test("room opt-out (requireClaimFiles:false) allows empty files but marks filesDeclared:false", async () => {
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { requireClaimFiles: false });
  const out = await call(registry, "owner", "create", null, { id: "optout" });
  assert.equal(out.status, 201);
  assert.equal(out.value.filesDeclared, false);
  // The claim round still works; the arbiter can see the undeclared scope.
  const claimed = await call(registry, "holder", "claim", "optout", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.filesDeclared, false);
});
