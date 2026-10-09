// FIX-45 (WAVE-300): file-less claims must not be created silently (COLLIDE-9).
// The file-lease collision system only works when claims declare files, so
// claim creation without a files declaration is refused with a 422 that names
// the requirement instead of succeeding silently.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const fakeHelpers = () => {
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return { json: (res, status, value) => ({ status, value }), reject, body: async req => req.body };
};
const fakeAuth = memberId => ({ member: { id: memberId, kind: "agent", permissions: [] } });
const runRoute = ({ route, id, body = {}, memberId = "quill", registry }) => handleWorkClaims({
  req: { method: "POST", body }, res: {}, url: {}, roomId: "room1",
  store: { roomAuthority: () => ({ members: {
    quill: { id: "quill", kind: "agent", active: true, permissions: ["verify"] },
    grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) },
  auth: fakeAuth(memberId), workClaimRoute: route, workClaimId: id,
  helpers: fakeHelpers(), registry,
});

test("FIX-45: create without files is a 422 naming the requirement", async () => {
  const registry = createWorkClaimRegistry();
  const error = await runRoute({ route: "create", body: { id: "fx45a" }, registry }).catch(e => e);
  assert.equal(error.status, 422);
  assert.equal(error.code, "work_claim_files_required");
  assert.match(error.message, /files/i); // names the requirement
});

test("FIX-45: create with files: null is also refused (absent, not declared)", async () => {
  const registry = createWorkClaimRegistry();
  const error = await runRoute({ route: "create", body: { id: "fx45n", files: null }, registry }).catch(e => e);
  assert.equal(error.status, 422);
  assert.equal(error.code, "work_claim_files_required");
});

test("FIX-45: create with files returns 201 as before", async () => {
  const registry = createWorkClaimRegistry();
  const result = await runRoute({ route: "create", body: { id: "fx45b", files: ["server/a.mjs"] }, registry });
  assert.equal(result.status, 201);
  assert.deepEqual(result.value.files, ["server/a.mjs"]);
});

test("FIX-45: create with explicit files: [] succeeds — declared no-files is visible, not silent", async () => {
  const registry = createWorkClaimRegistry();
  const result = await runRoute({ route: "create", body: { id: "fx45c", files: [] }, registry });
  assert.equal(result.status, 201);
  assert.deepEqual(result.value.files, []);
});

test("FIX-45: claim on an item that declares files works without re-declaring (200 as before)", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "fx45d", files: ["server/a.mjs"] }, registry });
  const result = await runRoute({ route: "claim", id: "fx45d", registry, memberId: "quill" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.files, ["server/a.mjs"]);
});

test("FIX-45: claim on a file-less item without declaring files is a 422, not a silent 200", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "fx45e", files: [] }, registry });
  const error = await runRoute({ route: "claim", id: "fx45e", body: {}, registry, memberId: "quill" }).catch(e => e);
  assert.equal(error.status, 422);
  assert.equal(error.code, "work_claim_files_required");
  assert.match(error.message, /declares no files/i); // names the requirement
});

test("FIX-45: claim on a file-less item with declared files succeeds (200)", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "fx45f", files: [] }, registry });
  const result = await runRoute({ route: "claim", id: "fx45f", body: { files: ["server/b.mjs"] }, registry, memberId: "quill" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.files, ["server/b.mjs"]);
});

test("FIX-45: create-with-assignee without files is refused too (immediate silent claim)", async () => {
  const registry = createWorkClaimRegistry();
  const error = await runRoute({ route: "create", body: { id: "fx45g", assignee: "grok" }, registry }).catch(e => e);
  assert.equal(error.status, 422);
  assert.equal(error.code, "work_claim_files_required");
});
