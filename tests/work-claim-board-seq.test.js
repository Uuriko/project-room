// F3 (wave300-fanout): delta board cursor. boardSeq is a per-room monotonic
// counter bumped inside the same transaction as every claim mutation; the
// board page carries it and ?since=N returns only claims mutated after N.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});
const database = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "board-seq-"));
  const file = join(dir, "room.sqlite");
  const open = () => { const db = new DatabaseSync(file); db.exec(workClaimSchema); return db; };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return open;
};

test("boardSeq starts at 0 and increments exactly once per mutation (create/claim/release/update/renew/reassign/close/cancel)", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal(registry.boardSeq("room1"), 0);

  assert.equal((await call(registry, "owner", "create", null, { id: "a" })).status, 201); // 1
  assert.equal(registry.boardSeq("room1"), 1);
  assert.equal(registry.get("room1", "a").boardSeq, 1);

  assert.equal((await call(registry, "owner", "claim", "a", {})).status, 200); // 2
  assert.equal((await call(registry, "owner", "release", "a", {})).status, 200); // 3
  assert.equal((await call(registry, "owner", "claim", "a", {})).status, 200); // 4
  assert.equal((await call(registry, "owner", "update", "a", { state: "in_progress" })).status, 200); // 5
  assert.equal((await call(registry, "owner", "renew", "a", {})).status, 200); // 6
  assert.equal((await call(registry, "owner", "reassign", "a", { newOwner: "holder" })).status, 200); // 7
  assert.equal((await call(registry, "holder", "close", "a", {})).status, 200); // 8
  assert.equal(registry.get("room1", "a").boardSeq, 8);

  assert.equal((await call(registry, "owner", "create", null, { id: "b" })).status, 201); // 9
  assert.equal((await call(registry, "owner", "cancel", "b", {})).status, 200); // 10
  assert.equal(registry.boardSeq("room1"), 10);
  assert.equal(registry.get("room1", "b").boardSeq, 10);
});

test("refused mutations do not bump boardSeq", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "a" });
  await call(registry, "owner", "claim", "a", {});
  assert.equal(registry.boardSeq("room1"), 2);
  // holder cannot claim an already-claimed item: 409, no bump.
  await assert.rejects(call(registry, "holder", "claim", "a", {}), error => error.status === 409);
  // unknown claim id: 404, no bump.
  await assert.rejects(call(registry, "owner", "claim", "missing", {}), error => error.status === 404);
  assert.equal(registry.boardSeq("room1"), 2);
});

test("?since=N returns only claims mutated after N, plus boardSeq and open/terminal counts", async () => {
  const registry = createWorkClaimRegistry();
  for (const id of ["c-1", "c-2", "c-3"]) {
    assert.equal((await call(registry, "owner", "create", null, { id })).status, 201);
    assert.equal((await call(registry, "owner", "claim", id, {})).status, 200);
  }
  const full = await call(registry, "owner", "list", null, undefined, "");
  assert.equal(full.status, 200);
  assert.equal(full.value.boardSeq, 6);

  assert.equal((await call(registry, "owner", "update", "c-2", { state: "in_progress" })).status, 200); // 7
  assert.equal((await call(registry, "owner", "update", "c-3", { state: "in_progress" })).status, 200); // 8

  const delta = await call(registry, "owner", "list", null, undefined, "?since=6");
  assert.equal(delta.status, 200);
  assert.deepEqual(delta.value.claims.map(claim => claim.id), ["c-2", "c-3"]); // mutation order
  assert.ok(delta.value.claims.every(claim => claim.boardSeq > 6));
  assert.equal(delta.value.boardSeq, 8);
  assert.equal(delta.value.openClaims, 3);
  assert.equal(delta.value.terminalClaims, 0);

  const empty = await call(registry, "owner", "list", null, undefined, "?since=8");
  assert.deepEqual(empty.value.claims, []);
  assert.equal(empty.value.boardSeq, 8);
  assert.equal(empty.value.openClaims, 3);
  assert.equal(empty.value.terminalClaims, 0);

  assert.equal((await call(registry, "owner", "close", "c-3", {})).status, 200); // 9
  const delta2 = await call(registry, "owner", "list", null, undefined, "?since=8");
  assert.deepEqual(delta2.value.claims.map(claim => claim.id), ["c-3"]);
  assert.equal(delta2.value.boardSeq, 9);
  assert.equal(delta2.value.openClaims, 2);
  assert.equal(delta2.value.terminalClaims, 1);
});

test("full page without since keeps its shape and gains only top-level boardSeq", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "s-1", title: "Shape" });
  await call(registry, "owner", "claim", "s-1", {});
  const page = await call(registry, "owner", "list", null, undefined, "");
  assert.equal(page.status, 200);
  assert.equal(page.value.boardSeq, registry.boardSeq("room1"));
  for (const claim of page.value.claims) assert.ok(!Object.hasOwn(claim, "boardSeq"), "full pages strip per-claim boardSeq");
  assert.deepEqual(Object.keys(page.value).sort(), ["boardSeq", "claims", "consistency", "contentTrust", "evaluatedAt",
    "hasMore", "historyLimit", "historyScope", "limit", "nextCursor", "roomId", "source", "swept"]);
});

test("invalid since is 400 invalid_input", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "a" });
  for (const query of ["?since=abc", "?since=-1", "?since=1.5", "?since=", "?since=1&cursor=x", "?since=1&queue=ready", "?since=1&state=done"]) {
    await assert.rejects(call(registry, "owner", "list", null, undefined, query),
      error => error.status === 400 && error.code === "invalid_input", query);
  }
  // since=0 is valid: every mutated claim has boardSeq >= 1.
  const page = await call(registry, "owner", "list", null, undefined, "?since=0");
  assert.equal(page.status, 200);
  assert.equal(page.value.claims.length, 1);
});

test("single-claim reads keep their existing shape (no boardSeq leak)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "r-1" });
  await call(registry, "owner", "claim", "r-1", {});
  const read = await call(registry, "owner", "read", "r-1", undefined);
  assert.equal(read.status, 200);
  assert.ok(!Object.hasOwn(read.value, "boardSeq"), "single-claim reads strip boardSeq");
  // The cursor still advanced underneath.
  assert.equal(registry.boardSeq("room1"), 2);
  assert.equal(registry.get("room1", "r-1").boardSeq, 2);
});

test("durable registry persists boardSeq and per-claim seq across restarts; legacy rows read as 0", async t => {
  const open = database(t);
  const first = open();
  const durable = createDurableWorkClaimRegistry(first);
  assert.equal(durable.boardSeq("room1"), 0);
  await call(durable, "owner", "create", null, { id: "rc-1" });
  await call(durable, "owner", "claim", "rc-1", {});
  assert.equal(durable.boardSeq("room1"), 2);
  assert.equal(durable.get("room1", "rc-1").boardSeq, 2);
  first.close();

  const second = open();
  t.after(() => second.close());
  const restarted = createDurableWorkClaimRegistry(second);
  assert.equal(restarted.boardSeq("room1"), 2);
  assert.equal(restarted.get("room1", "rc-1").boardSeq, 2);
  await call(restarted, "owner", "update", "rc-1", { state: "in_progress" });
  assert.equal(restarted.boardSeq("room1"), 3);

  // A row written before boardSeq existed decodes with boardSeq 0.
  second.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)")
    .run("room1", "legacy", JSON.stringify({ id: "legacy", state: "unclaimed" }), Date.now());
  assert.equal(restarted.get("room1", "legacy").boardSeq, 0);

  // The delta route works against the durable registry too.
  const delta = await call(restarted, "owner", "list", null, undefined, "?since=2");
  assert.deepEqual(delta.value.claims.map(claim => claim.id), ["rc-1"]);
  assert.equal(delta.value.boardSeq, 3);
});
