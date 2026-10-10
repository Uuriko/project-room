// FIX-46 (WAVE-300): holder-side blockedAttempts counter. The holder of a
// claim / file lease gets visibility into contention: every blocked attempt
// (409 on claim by a foreign agent, file-lease contention 409) increments a
// per-item counter the holder reads on GET work-claims. The counter is part
// of the durable claim record (SQLite), not in-memory. It resets to 0 when
// the hold ends (release, lease-expiry auto-release, close/cancel) or moves
// (reassign, fresh claim). Self re-claim 409s and stale-round preconditions
// are not contention and do not count.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const members = {
  jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  claude: { id: "claude", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
};
const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" || route === "list" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : (route === "list" ? "" : `/${route}`)}`),
  store: { roomAuthority: () => ({ members }) },
  roomId: "room1",
  auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});
const database = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "work-claim-blocked-"));
  const file = join(dir, "room.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => { const db = new DatabaseSync(file); db.exec(workClaimSchema); return db; };
  return open;
};
const roundOfItem = item => ({ expectedClaimedAt: item?.claimedAt ?? null,
  expectedHistoryLength: (item?.history?.length ?? 0) + (Number(item?.historyOmitted) || 0) });

test("FIX-46: a foreign claim attempt 409 increments the holder's blockedAttempts", async t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  await call(registry, "jill", "create", null, { id: "a", title: "hot item" });
  await call(registry, "jill", "claim", "a", {});

  const blocked = await call(registry, "grokbot", "claim", "a", {}).catch(e => e);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "work_claim_conflict");

  const read = await call(registry, "jill", "read", "a");
  assert.equal(read.status, 200);
  assert.equal(read.value.blockedAttempts, 1, "holder sees the blocked attempt on GET");

  await call(registry, "claude", "claim", "a", {}).catch(e => e);
  const reread = await call(registry, "jill", "read", "a");
  assert.equal(reread.value.blockedAttempts, 2, "each blocked attempt increments");
});

test("FIX-46: file-lease contention 409 increments the lease holder's counter", async t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "grokbot", "create", null, { id: "b" });

  // Claim-route file-lease contention. FIX-71: the hard refusal needs an
  // explicit exclusive upgrade — the holder's counter still increments.
  const conflict = await call(registry, "grokbot", "claim", "b", { files: ["server/a.mjs"], exclusive: true }).catch(e => e);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.value.error.code, "file_lease_conflict");
  let read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.blockedAttempts, 1, "holder sees the lease-contention attempt");

  // Create-with-assignee file-lease contention (item never created — the 409 is atomic).
  const created = await call(registry, "claude", "create", null, { id: "c", files: ["server/a.mjs"], assignee: "grokbot", exclusive: true }).catch(e => e);
  assert.equal(created.status, 409);
  assert.equal(created.value.error.code, "file_lease_conflict");
  read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.blockedAttempts, 2);
});

test("FIX-46: release resets the counter; a fresh hold starts at zero", async t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  await call(registry, "jill", "create", null, { id: "a" });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "grokbot", "claim", "a", {}).catch(e => e);
  assert.equal((await call(registry, "jill", "read", "a")).value.blockedAttempts, 1);

  const held = (await call(registry, "jill", "read", "a")).value;
  const released = await call(registry, "jill", "release", "a", { ...roundOfItem(held) });
  assert.equal(released.status, 200);
  assert.equal(released.value.blockedAttempts, 0, "release resets the counter");
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.owner, null);

  // A fresh claim by someone else starts at zero, not at the old count.
  await call(registry, "grokbot", "claim", "a", {});
  assert.equal((await call(registry, "grokbot", "read", "a")).value.blockedAttempts, 0);
});

test("FIX-46: the counter survives a registry rebuild (durable, not in-memory)", async t => {
  const open = database(t);
  const first = open();
  const registry = createDurableWorkClaimRegistry(first);
  await call(registry, "jill", "create", null, { id: "a" });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "grokbot", "claim", "a", {}).catch(e => e);
  first.close();

  const second = open();
  t.after(() => second.close());
  const restarted = createDurableWorkClaimRegistry(second);
  const read = await call(restarted, "jill", "read", "a");
  assert.equal(read.value.blockedAttempts, 1, "counter persisted in the SQLite record");
});

test("FIX-46: self re-claim 409 is not contention and does not increment", async t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  await call(registry, "jill", "create", null, { id: "a" });
  await call(registry, "jill", "claim", "a", {});
  const self = await call(registry, "jill", "claim", "a", {}).catch(e => e);
  assert.equal(self.status, 409);
  assert.equal((await call(registry, "jill", "read", "a")).value.blockedAttempts, 0);
});

test("FIX-46: additive — the 409 bodies and existing item fields are unchanged", async t => {
  const open = database(t);
  const db = open();
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  await call(registry, "jill", "create", null, { id: "a", title: "hot item", files: ["server/a.mjs"] });
  const claimed = await call(registry, "jill", "claim", "a", {});
  assert.equal(claimed.value.blockedAttempts, 0, "fresh hold carries a zero counter");

  const blocked = await call(registry, "grokbot", "claim", "a", {}).catch(e => e);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "work_claim_conflict");
  assert.match(blocked.message, /held by jill/);

  const read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.owner, "jill");
  assert.equal(read.value.state, "claimed");
  assert.equal(read.value.title, "hot item");
  assert.deepEqual(read.value.files, ["server/a.mjs"]);
  assert.ok(typeof read.value.blockedAttempts === "number");

  const listed = await call(registry, "jill", "list", null, {});
  const listedItem = listed.value.claims.find(item => item.id === "a");
  assert.equal(listedItem.blockedAttempts, 1, "board list exposes the counter too");
});
