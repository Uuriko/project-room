// BOARD-LIFECYCLE-1: regression tests for three board lifecycle defects
// confirmed by execution on production (QA-CARDS-TRIAGE, cards 1/3/4):
//  1. removing a member strands their live claims for the full lease;
//  2. closing a prerequisite strands its dependents with no in-API escape;
//  3. create accepts claim ids (_draft, constructor, ...) that no read or
//     claim path can ever reach.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const BUNDLE = { artifact: { kind: "text", ref: "room://artifacts/lifecycle", sha256: "c".repeat(64) },
  checks: [{ name: "unit", result: "pass" }], criteria: [] };

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind, permissions }
  });
  add("coord", "Coord", "agent", ["accept_work", "complete_work"]);
  add("chat", "Chat", "agent", []);
  add("verifier", "Verifier", "human", ["verify"]);
  const coordKey = store.issueAccessKey("commons", "coord");
  const chatKey = store.issueAccessKey("commons", "chat");
  const server = createRoomServer({ store, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, ownerKey, coordKey, chatKey, call };
}

const stripTrust = value => JSON.parse(JSON.stringify(value, (key, entry) => (key === "untrusted" || key === "contentTrust" ? undefined : entry)));

// --- Card 4: create-side id validation ---

test("create refuses claim ids that no read or claim path can reach (removed: leading _ or -, reserved names)", async t => {
  const f = await fixture(t);
  for (const id of ["_draft", "-wip", "constructor", "prototype", "__proto__"]) {
    const created = await f.call(f.ownerKey, "/work-claims", { id });
    assert.equal(created.status, 422, `create ${id} must be refused, got ${created.status}`);
    assert.equal(created.value.error.code, "invalid_claim_input");
    assert.match(created.value.error.message, /starts with a letter or digit/);
    const listed = await f.call(f.ownerKey, "/work-claims");
    assert.ok(!stripTrust(listed.value).claims?.some(entry => entry.id === id), `${id} must not be on the board`);
  }
});

test("create accepts a well-formed id and the claim reads and claims normally", async t => {
  const f = await fixture(t);
  const created = await f.call(f.ownerKey, "/work-claims", { id: "triage-control" });
  assert.equal(created.status, 201);
  const read = await f.call(f.ownerKey, "/work-claims/triage-control");
  assert.equal(read.status, 200);
  const claimed = await f.call(f.coordKey, "/work-claims/triage-control/claim", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
});

test("create and claim refuse malformed dependsOn entries, naming the id rule", async t => {
  const f = await fixture(t);
  const created = await f.call(f.ownerKey, "/work-claims", { id: "dependent-x", dependsOn: ["-wip"] });
  assert.equal(created.status, 422);
  assert.equal(created.value.error.code, "invalid_claim_input");
  assert.match(created.value.error.message, /dependsOn/);
  assert.match(created.value.error.message, /starts with a letter or digit/);

  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "plain-task" })).status, 201);
  const claimed = await f.call(f.coordKey, "/work-claims/plain-task/claim", { dependsOn: ["__proto__"] });
  assert.equal(claimed.status, 422);
  assert.equal(claimed.value.error.code, "invalid_claim_input");
  assert.match(claimed.value.error.message, /starts with a letter or digit/);
});

// --- Card 3: closed-dependency escape ---

test("a closed prerequisite strands the dependent until the owner drops the closed dependency", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "prereq-a" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "dependent-a", dependsOn: ["prereq-a"] })).status, 201);
  const closed = await f.call(f.ownerKey, "/work-claims/prereq-a/close", { reason: "not needed" });
  assert.equal(closed.status, 200);
  assert.equal(closed.value.state, "closed");

  const refused = await f.call(f.coordKey, "/work-claims/dependent-a/claim", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.value.error.code, "work_claim_dependencies_unmet");
  assert.match(refused.value.error.message, /closed/);
  assert.match(refused.value.error.message, /drop/);

  const dropped = await f.call(f.ownerKey, "/work-claims/dependent-a/update", { dependsOn: [] });
  assert.equal(dropped.status, 200);
  assert.deepEqual(dropped.value.dependsOn, []);

  const claimed = await f.call(f.coordKey, "/work-claims/dependent-a/claim", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
});

test("only closed dependencies can be dropped, additions are refused, and only the creator or a manager may drop", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "prereq-b" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "dependent-b", dependsOn: ["prereq-b"] })).status, 201);
  // prereq-b is still open: dropping it would rewrite the dependency contract.
  const early = await f.call(f.ownerKey, "/work-claims/dependent-b/update", { dependsOn: [] });
  assert.equal(early.status, 422);
  assert.equal(early.value.error.code, "invalid_claim_input");
  // Additions are never a drop.
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "other-b" })).status, 201);
  const added = await f.call(f.ownerKey, "/work-claims/dependent-b/update", { dependsOn: ["prereq-b", "other-b"] });
  assert.equal(added.status, 422);
  assert.equal(added.value.error.code, "invalid_claim_input");

  // Creator path: coord creates the pair, the owner closes the prerequisite,
  // an unrelated member cannot drop, the creator can.
  assert.equal((await f.call(f.coordKey, "/work-claims", { id: "prereq-c" })).status, 201);
  assert.equal((await f.call(f.coordKey, "/work-claims", { id: "dependent-c", dependsOn: ["prereq-c"] })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims/prereq-c/close", { reason: "superseded" })).status, 200);
  const stranger = await f.call(f.chatKey, "/work-claims/dependent-c/update", { dependsOn: [] });
  assert.equal(stranger.status, 403);
  const byCreator = await f.call(f.coordKey, "/work-claims/dependent-c/update", { dependsOn: [] });
  assert.equal(byCreator.status, 200);
  assert.deepEqual(byCreator.value.dependsOn, []);
});

// --- Card 1: removal releases live claims ---

test("removing a member releases their live claims in the same command; done work keeps its attribution", async t => {
  const f = await fixture(t);
  // A claim coord finished stays done and attributed to coord after removal.
  assert.equal((await f.call(f.coordKey, "/work-claims", { id: "done-task", reviewPolicy: "self_attested" })).status, 201);
  assert.equal((await f.call(f.coordKey, "/work-claims/done-task/claim", {})).status, 200);
  assert.equal((await f.call(f.coordKey, "/work-claims/done-task/update", { state: "in_progress" })).status, 200);
  assert.equal((await f.call(f.coordKey, "/work-claims/done-task/update", { state: "delivered", delivery: BUNDLE })).status, 200);
  const done = await f.call(f.coordKey, "/work-claims/done-task/update", { state: "done" });
  assert.equal(done.status, 200);
  assert.equal(done.value.state, "done");

  // A live claim holding a file lease.
  assert.equal((await f.call(f.coordKey, "/work-claims", { id: "held-task", files: ["src/shared.js"] })).status, 201);
  assert.equal((await f.call(f.coordKey, "/work-claims/held-task/claim", {})).status, 200);
  // While coord holds it, the owner's overlapping claim hits the file lease.
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "overlap-task", files: ["src/shared.js"] })).status, 201);
  const conflict = await f.call(f.ownerKey, "/work-claims/overlap-task/claim", {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.value.error.code, "file_lease_conflict");

  const revision = f.store.room("commons").state.members.coord.revision;
  f.store.command(f.ownerKey, "commons", {
    id: "remove-coord", type: "member.access_changed",
    data: { memberId: "coord", expectedMemberRevision: revision, active: false, permissions: [] }
  });

  const held = await f.call(f.ownerKey, "/work-claims/held-task");
  assert.equal(held.status, 200);
  assert.equal(held.value.state, "unclaimed");
  assert.equal(held.value.owner, null);
  const releaseStamp = held.value.history.filter(entry => entry.action === "released").at(-1);
  assert.ok(releaseStamp, "the release is stamped in history");
  assert.match(releaseStamp.note ?? "", /released on member removal/);

  // The stranded-work symptom is gone: a remaining member can claim it now.
  const claimed = await f.call(f.ownerKey, "/work-claims/held-task/claim", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");

  // Done work is untouched and still attributed to the removed member.
  const doneAfter = await f.call(f.ownerKey, "/work-claims/done-task");
  assert.equal(doneAfter.value.state, "done");
  const doneStamp = doneAfter.value.history.filter(entry => entry.action === "state:done").at(-1);
  assert.ok(doneStamp, "done stamp survives");
  assert.equal(doneStamp.agentId, "coord");
});
