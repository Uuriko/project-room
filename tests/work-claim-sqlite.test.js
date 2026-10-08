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

test("a claim survives a restart on the durable registry and is lost on the in-memory one", async t => {
  const open = database(t);
  const first = open();
  const durable = createDurableWorkClaimRegistry(first);
  await call(durable, "jill", "create", null, { id: "rc-1", title: "Board v2", files: ["src/rc-1.mjs"] });
  const claimed = await call(durable, "jill", "claim", "rc-1", { leaseHours: 1 });
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

test("room work-claim config persists across restarts", t => {
  const open = database(t);
  const first = open();
  createDurableWorkClaimRegistry(first).configure("room1", { defaultLeaseHours: 1 });
  first.close();
  const second = open();
  t.after(() => second.close());
  assert.equal(createDurableWorkClaimRegistry(second).configFor("room1").defaultLeaseHours, 1);
});

test("room work-claim config clamps an over-cap defaultLeaseHours on write", t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  // 12h exceeds the 2h hard cap: persisted as 2, never as 12.
  assert.equal(registry.configure("room1", { defaultLeaseHours: 12 }).defaultLeaseHours, 2);
  assert.equal(registry.configFor("room1").defaultLeaseHours, 2);
  assert.equal(registry.rawConfig("room1").defaultLeaseHours, 2);
});
