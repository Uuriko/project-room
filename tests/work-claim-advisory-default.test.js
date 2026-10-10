// FIX-71 (WAVE-300): advisory-by-default file leases. A file-lease overlap
// no longer hard-refuses: the claim lands and the 200 body carries
// fileConflicts[] naming the conflicting holders — the same info the 409
// body carries. A hard 409 file_lease_conflict is returned only when the
// claim explicitly requests an exclusive lease upgrade (exclusive: true)
// and conflicts with an existing lease, or when the overlap is with an
// existing exclusive lease (exclusive means exclusive). Advisory overlaps
// still increment each holder's blockedAttempts (FIX-46 contention
// visibility).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { claimWork } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-09T16:00:00.000Z");
const helpers = () => ({
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
});
const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: { roomAuthority: () => ({ members: {
    jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    claude: { id: "claude", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    ada: { id: "ada", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  } }) },
  roomId: "room1",
  auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route,
  workClaimId: id,
  helpers: helpers(),
  registry,
});

test("FIX-71: a default claim overlapping a live lease lands with fileConflicts[]", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  const held = await call(registry, "jill", "claim", "a", {});
  assert.equal(held.status, 200);
  await call(registry, "grokbot", "create", null, { id: "b" });

  const out = await call(registry, "grokbot", "claim", "b", { files: ["server/a.mjs"] });
  assert.equal(out.status, 200, "advisory by default: overlap is not a 409");
  assert.equal(out.value.state, "claimed");
  assert.equal(out.value.owner, "grokbot");
  assert.deepEqual(out.value.fileConflicts, [{
    holder: { claimId: "a", owner: "jill" },
    files: ["server/a.mjs"],
    leaseExpiresAt: held.value.leaseExpiresAt,
    exclusive: false,
  }], "fileConflicts names the holder, files and lease expiry like the 409 body");
  assert.equal(registry.get("room1", "b").state, "claimed");
});

test("FIX-71: an exclusive upgrade that conflicts is refused with the FIX-9 409 body", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  const held = await call(registry, "jill", "claim", "a", {});
  await call(registry, "grokbot", "create", null, { id: "b" });

  const out = await call(registry, "grokbot", "claim", "b", { files: ["server/a.mjs"], exclusive: true });
  assert.equal(out.status, 409);
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.deepEqual(out.value.holder, { claimId: "a", owner: "jill" });
  assert.deepEqual(out.value.files, ["server/a.mjs"]);
  assert.equal(out.value.leaseExpiresAt, held.value.leaseExpiresAt);
  assert.equal(registry.get("room1", "b").state, "unclaimed", "the refused claim is never landed");
  const read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.blockedAttempts, 1, "the exclusive-upgrade attempt is contention the holder sees");
});

test("FIX-71: overlap with an existing exclusive lease is refused even for a default claim", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  const held = await call(registry, "jill", "claim", "a", { exclusive: true });
  assert.equal(held.status, 200);
  assert.equal(held.value.leaseExclusive, true, "the exclusive lease is recorded on the item");
  await call(registry, "grokbot", "create", null, { id: "b" });

  const out = await call(registry, "grokbot", "claim", "b", { files: ["server/a.mjs"] });
  assert.equal(out.status, 409, "exclusive means exclusive");
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.deepEqual(out.value.holder, { claimId: "a", owner: "jill" });
  assert.equal(registry.get("room1", "b").state, "unclaimed");
});

test("FIX-71: advisory overlaps increment the holder's blockedAttempts", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "grokbot", "create", null, { id: "b" });

  const out = await call(registry, "grokbot", "claim", "b", { files: ["server/a.mjs"] });
  assert.equal(out.status, 200);
  const read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.blockedAttempts, 1, "the holder sees advisory contention too");
});

test("FIX-71: exclusive: true with no overlap claims and records the lease", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  const out = await call(registry, "jill", "claim", "a", { exclusive: true });
  assert.equal(out.status, 200);
  assert.equal(out.value.leaseExclusive, true);
  assert.deepEqual(out.value.fileConflicts, []);
  // the flag is served on reads and survives the round-trip
  const read = await call(registry, "jill", "read", "a");
  assert.equal(read.value.leaseExclusive, true);
});

test("FIX-71: a default claim records an advisory (non-exclusive) lease", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  const out = await call(registry, "jill", "claim", "a", {});
  assert.equal(out.status, 200);
  assert.equal(out.value.leaseExclusive, false);
});

test("FIX-71: exclusive must be a boolean", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a" });
  const out = await call(registry, "jill", "claim", "a", { exclusive: "yes" }).catch(error => error);
  assert.equal(out.status, 422);
});

test("FIX-71: create-with-assignee is advisory by default, hard on exclusive upgrade", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});

  const advisory = await call(registry, "claude", "create", null, { id: "b", files: ["server/a.mjs"], assignee: "ada" });
  assert.equal(advisory.status, 201);
  assert.equal(advisory.value.owner, "ada");
  assert.equal(advisory.value.fileConflicts.length, 1);
  assert.equal(advisory.value.fileConflicts[0].holder.claimId, "a");

  const hard = await call(registry, "claude", "create", null, { id: "c", files: ["server/a.mjs"], assignee: "ada", exclusive: true });
  assert.equal(hard.status, 409);
  assert.equal(hard.value.error.code, "file_lease_conflict");
  assert.equal(registry.has("room1", "c"), false, "the refused create is atomic — the item is never created");
});

test("FIX-71: reassign of an overlap is advisory unless a lease is exclusive", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", { exclusive: true });
  await call(registry, "claude", "create", null, { id: "b", files: ["server/a.mjs"] });
  const before = await call(registry, "claude", "read", "b");

  const out = await call(registry, "claude", "reassign", "b", {
    newOwner: "ada",
    expectedClaimedAt: before.value.claimedAt ?? null,
    expectedHistoryLength: (before.value.history?.length ?? 0) + (Number(before.value.historyOmitted) || 0),
  }).catch(error => error);
  assert.equal(out.status, 409, "the holder's exclusive lease refuses the incoming overlap");
  assert.equal(out.code ?? out.value?.error?.code, "file_lease_conflict");
});

test("FIX-71: pure machine — claimWork stamps leaseExclusive, workOf normalizes", () => {
  const exclusive = claimWork({ id: "w1" }, "quill", { exclusive: true, now: T0 });
  assert.equal(exclusive.leaseExclusive, true);
  const advisory = claimWork({ id: "w2" }, "quill", { now: T0 });
  assert.equal(advisory.leaseExclusive, false);
  const coerced = claimWork({ id: "w3" }, "quill", { exclusive: 1, now: T0 });
  assert.equal(coerced.leaseExclusive, false, "only true opts into exclusivity");
});

test("FIX-71: the exclusive lease survives a registry rebuild (durable, not in-memory)", async t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "work-claim-fix71-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "room.sqlite");
  const open = () => { const db = new DatabaseSync(file); db.exec(workClaimSchema); return db; };
  const first = open();
  const registry = createDurableWorkClaimRegistry(first);
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", { exclusive: true });
  first.close();

  const second = open();
  t.after(() => second.close());
  const restarted = createDurableWorkClaimRegistry(second);
  const read = await call(restarted, "jill", "read", "a");
  assert.equal(read.value.leaseExclusive, true, "exclusivity persisted in the SQLite record");
  await call(restarted, "grokbot", "create", null, { id: "b" });
  const out = await call(restarted, "grokbot", "claim", "b", { files: ["server/a.mjs"] });
  assert.equal(out.status, 409, "the rebuilt registry still hard-refuses the overlap");
  assert.equal(out.value.error.code, "file_lease_conflict");
});
