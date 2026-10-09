// FIX-48 (ranked-fixes burn-down): thin-spine scope dedup at claim time,
// advisory-first.
//
// Live observation: two claims with overlapping guild scopes (a directory
// scope vs a file scope under it — the "coordination-robustness" vs
// "collide" style overlap) were BOTH accepted at claim time with no overlap
// signal. The existing 409 file_lease_conflict spine only sees EXACT path
// matches (server/claim-coordination.mjs slotsConflict); a directory scope
// covering a file scope sails through silently.
//
// Enforcement choice (documented in docs/WORK-CLAIMS.md): ADVISORY-FIRST.
// Exact-path overlap keeps the established 409. Prefix-only overlap warns:
// the claim still lands (nothing that previously succeeded can now fail),
// the warning is stamped on the claim history (so the commit's single
// work_claim.updated room event carries it) and returned as
// scopeOverlapWarnings on the 200 response.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { scopePrefixOverlaps } from "../server/claim-coordination.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  const get = async path => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      headers: { authorization: `Bearer ${ownerKey}` }
    });
    return { status: response.status, value: await response.json() };
  };
  return { post, get };
}

async function createAndClaim(f, id, files, extra = {}) {
  assert.equal((await f.post("/work-claims", { id, title: id })).status, 201, `create ${id}`);
  const res = await f.post(`/work-claims/${id}/claim`, { files, ...extra });
  assert.equal(res.status, 200, `claim ${id} lands: ${JSON.stringify(res.value).slice(0, 300)}`);
  return res.value;
}

test("prefix overlap warns but the claim still lands (advisory-first)", async t => {
  const f = await fixture(t);
  // Live shape: one lane holds a directory scope, another claims a file under it.
  await createAndClaim(f, "coordination-robustness", ["server/coordination/"]);
  const claimed = await createAndClaim(f, "collide", ["server/coordination/robustness.mjs"]);
  assert.ok(Array.isArray(claimed.scopeOverlapWarnings), "response carries scopeOverlapWarnings");
  assert.equal(claimed.scopeOverlapWarnings.length, 1, "one overlapping holder");
  const [warning] = claimed.scopeOverlapWarnings;
  assert.equal(warning.holder.claimId, "coordination-robustness", "warning names the holder");
  assert.match(warning.scopes.join(" "), /server\/coordination/, "warning names the overlapping scopes");
  const stamped = (claimed.history ?? []).some(entry => entry.action === "scope_overlap_warning"
    && /coordination-robustness/.test(entry.note ?? ""));
  assert.ok(stamped, "warning is stamped on the claim history so the room event carries it");
});

test("prefix overlap in the other direction warns too", async t => {
  const f = await fixture(t);
  await createAndClaim(f, "dir-first", ["server/http.mjs"]);
  const claimed = await createAndClaim(f, "dir-second", ["server/"]);
  assert.ok(Array.isArray(claimed.scopeOverlapWarnings));
  assert.equal(claimed.scopeOverlapWarnings.length, 1);
  assert.equal(claimed.scopeOverlapWarnings[0].holder.claimId, "dir-first");
});

test("disjoint scopes claim with no warnings", async t => {
  const f = await fixture(t);
  await createAndClaim(f, "lane-a", ["server/a.mjs"]);
  const claimed = await createAndClaim(f, "lane-b", ["server/b.mjs"]);
  assert.deepEqual(claimed.scopeOverlapWarnings, [], "no warnings for disjoint scopes");
});

test("exact-path overlap is still refused with 409 (the existing spine)", async t => {
  const f = await fixture(t);
  await createAndClaim(f, "exact-a", ["server/a.mjs"]);
  assert.equal((await f.post("/work-claims", { id: "exact-b", title: "exact-b" })).status, 201);
  const res = await f.post("/work-claims/exact-b/claim", { files: ["server/a.mjs"] });
  assert.equal(res.status, 409, "exact overlap stays a refusal");
  assert.equal(res.value.error.code, "file_lease_conflict");
});

test("advisory:true with a prefix overlap still claims and warns", async t => {
  const f = await fixture(t);
  await createAndClaim(f, "adv-a", ["server/"]);
  const claimed = await createAndClaim(f, "adv-b", ["server/x.mjs"], { advisory: true });
  assert.ok(Array.isArray(claimed.scopeOverlapWarnings));
  assert.equal(claimed.scopeOverlapWarnings.length, 1, "advisory claims get the prefix warning too");
});

test("a released claim stops warning", async t => {
  const f = await fixture(t);
  const before = await createAndClaim(f, "rel-a", ["server/"]);
  const read = await f.get("/work-claims/rel-a");
  assert.equal(read.status, 200);
  const release = await f.post("/work-claims/rel-a/release", {
    reason: "done",
    expectedClaimedAt: read.value.claimedAt,
    expectedHistoryLength: read.value.history.length + (read.value.historyOmitted ?? 0)
  });
  assert.equal(release.status, 200, `release lands: ${JSON.stringify(release.value).slice(0, 200)}`);
  const claimed = await createAndClaim(f, "rel-b", ["server/x.mjs"]);
  assert.deepEqual(claimed.scopeOverlapWarnings, [], "closed claims hold no scope");
});

// Pure-function edge cases for the FIX-24 semantics reused at claim time.
const item = (id, state, files, fileBlocks = {}) => ({ id, state, owner: "m", files, fileBlocks });

test("scopePrefixOverlaps: exact-path pairs belong to the 409 spine, not the warning", () => {
  assert.deepEqual(
    scopePrefixOverlaps([item("a", "claimed", ["server/a.mjs"])], item("b", "claimed", ["server/a.mjs"])),
    [],
    "same path on both sides is not a prefix overlap"
  );
});

test("scopePrefixOverlaps: same path with different block labels does not warn", () => {
  const overlaps = scopePrefixOverlaps(
    [item("a", "claimed", ["server/a.mjs"], { "server/a.mjs": "imports" })],
    item("b", "claimed", ["server/a.mjs"], { "server/a.mjs": "exports" })
  );
  assert.deepEqual(overlaps, [], "label exemption stays with the exact-path spine");
});

test("scopePrefixOverlaps: blocked holders still warn, done holders do not", () => {
  // Paths here are in stored (claim-machine-normalized) form — no trailing
  // slashes — matching the contract fileSlots documents. The HTTP tests
  // above cover the "server/" -> "server" normalization through the machine.
  const blocked = scopePrefixOverlaps(
    [item("a", "blocked", ["server"])], item("b", "claimed", ["server/x.mjs"]));
  assert.equal(blocked.length, 1, "blocked claims hold their scope");
  const done = scopePrefixOverlaps(
    [item("a", "done", ["server"])], item("b", "claimed", ["server/x.mjs"]));
  assert.deepEqual(done, [], "done claims hold nothing");
});

test("scopePrefixOverlaps: prefix matching is on path segments, not string prefixes", () => {
  const overlaps = scopePrefixOverlaps(
    [item("a", "claimed", ["server/"])], item("b", "claimed", ["server2/x.mjs"]));
  assert.deepEqual(overlaps, [], "server/ does not cover server2/");
});

test("scopePrefixOverlaps: ignores the claim itself", () => {
  const self = item("a", "claimed", ["server/x.mjs"]);
  assert.deepEqual(scopePrefixOverlaps([self], self), [], "a claim never overlaps itself");
});
