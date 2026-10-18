// Durable work-claim registry (server/work-claim-sqlite.mjs).
// Contract guarded: a claim made through the real work-claim routes is still
// there, with its owner and lease, after the registry is rebuilt on the same
// database. That is what a Durable Object restart or deploy does to the
// in-memory registry today, which loses every claim.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" ? "GET" : "POST", body }, res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: { roomAuthority: () => ({ members: {
    jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) }, roomId: "room1", auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

const database = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "work-claim-store-"));
  const file = join(dir, "room.sqlite");
  const open = () => { const db = new DatabaseSync(file); db.exec(workClaimSchema); return db; };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return open;
};

// The scale lane's counting method: wrap db.prepare and count calls.
const countingDb = db => {
  const counter = { prepares: 0 };
  const real = db.prepare.bind(db);
  db.prepare = sql => { counter.prepares++; return real(sql); };
  return counter;
};

test("a claim survives a restart on the durable registry and is lost on the in-memory one", async t => {
  const open = database(t);
  const first = open();
  const durable = createDurableWorkClaimRegistry(first);
  await call(durable, "jill", "create", null, { id: "rc-1", title: "Board v2" });
  const claimed = await call(durable, "jill", "claim", "rc-1", { leaseHours: 6 });
  first.close();

  const second = open();
  t.after(() => second.close());
  const restarted = createDurableWorkClaimRegistry(second);
  const read = await call(restarted, "jill", "read", "rc-1");
  assert.equal(read.value.owner, "jill");
  assert.equal(read.value.state, "claimed");
  assert.equal(read.value.leaseExpiresAt, claimed.value.leaseExpiresAt);

  // Same routes, one more claim attempt by another agent: the durable
  // anti-collision rule still holds after the restart.
  await assert.rejects(call(restarted, "grokbot", "claim", "rc-1", {}), error => error.status === 409);

  const memory = createWorkClaimRegistry();
  await assert.rejects(call(memory, "jill", "read", "rc-1"), error => error.status === 404);
});

test("statements prepare once per registry, not once per call (PERF2-BOARD step 1)", t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const counter = countingDb(db);
  const registry = createDurableWorkClaimRegistry(db);
  // Warm-up: one of every operation, so each distinct SQL string in the
  // module (seven today: selectOne, selectRoom, upsert, remove,
  // selectConfig, upsertConfig, and verifySchema's sqlite_master probe)
  // has prepared exactly once.
  registry.set("room1", { id: "c-0", title: "Scratch" });
  registry.set("room1", { id: "c-1", title: "One" });
  registry.get("room1", "c-1");
  registry.list("room1");
  registry.configure("room1", { defaultLeaseHours: 3 });
  registry.delete("room1", "c-0");
  assert.equal(registry.verifySchema(), true);
  const warm = counter.prepares;
  assert.ok(warm > 0 && warm <= 7, `warm-up prepared ${warm} statements (module has 7 distinct SQL strings)`);
  counter.prepares = 0;
  for (let i = 0; i < 25; i++) {
    registry.get("room1", "c-1");
    registry.has("room1", "c-1");
    registry.list("room1");
    registry.set("room1", { id: "c-1", title: "One" });
    registry.configFor("room1");
  }
  registry.delete("room1", "c-1");
  assert.equal(registry.verifySchema(), true);
  assert.equal(counter.prepares, 0, "no call re-prepares once the cache is warm");
});

test("cached statements stay correct when the schema moves under a live registry", t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  registry.set("room1", { id: "c-1", title: "Before" });
  assert.equal(registry.get("room1", "c-1").title, "Before"); // cache warm

  // Additive change (a migration adding a column): reads and writes keep
  // working on the same cached statements.
  db.exec("ALTER TABLE work_claims ADD COLUMN note TEXT");
  assert.equal(registry.get("room1", "c-1").title, "Before");
  registry.set("room1", { id: "c-2", title: "After alter" });
  assert.equal(registry.get("room1", "c-2").title, "After alter");

  // Replacement (operator reconciliation drops and recreates the table):
  // the cached SELECT must read the new, empty table — never ghost rows.
  db.exec("DROP TABLE work_claims");
  db.exec(workClaimSchema);
  assert.equal(registry.get("room1", "c-1"), null);
  registry.set("room1", { id: "c-3", title: "Recreated" });
  assert.equal(registry.get("room1", "c-3").title, "Recreated");
  assert.equal(registry.list("room1").length, 1);
});

test("a reopened store gets a fresh cache on its own handle, usable across transaction boundaries", t => {
  const open = database(t);
  const first = open();
  createDurableWorkClaimRegistry(first).set("room1", { id: "c-1", title: "Persisted" });
  first.close();

  const second = open();
  t.after(() => second.close());
  const counter = countingDb(second);
  const registry = createDurableWorkClaimRegistry(second);
  assert.equal(registry.get("room1", "c-1").title, "Persisted");
  registry.set("room1", { id: "c-0", title: "Warm-up" }); // warm the upsert too
  assert.ok(counter.prepares > 0, "the new registry prepares against its own handle");
  counter.prepares = 0;
  // Statements prepared outside a transaction run inside one, and back.
  second.exec("BEGIN");
  registry.set("room1", { id: "c-2", title: "In transaction" });
  assert.equal(registry.get("room1", "c-2").title, "In transaction");
  second.exec("COMMIT");
  assert.equal(registry.get("room1", "c-2").title, "In transaction");
  assert.equal(counter.prepares, 0, "crossing a transaction boundary never re-prepares");
});

test("room work-claim config persists across restarts", t => {
  const open = database(t);
  const first = open();
  createDurableWorkClaimRegistry(first).configure("room1", { defaultLeaseHours: 12 });
  first.close();
  const second = open();
  t.after(() => second.close());
  assert.equal(createDurableWorkClaimRegistry(second).configFor("room1").defaultLeaseHours, 12);
});
