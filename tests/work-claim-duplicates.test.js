// Work-claim duplicate detection (Linear "similar issues" emulation).
// Pure-module tests (scoring, ranking, validation) plus a handler smoke
// test with fakes (wiring, not the network).
import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, scoreItem, findDuplicates, DuplicateError } from "../server/work-duplicates.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DuplicateError && error.code === code);

// --- tokenize ---

test("tokenize lowercases, splits on non-alphanumerics, strips stopwords", () => {
  assert.deepEqual([...tokenize("Fix the Login BUG!")].sort(), ["bug", "fix", "login"]);
  assert.deepEqual([...tokenize("the and of")], []);
  assert.deepEqual([...tokenize("")], []);
  assert.deepEqual([...tokenize(null)], []);
});

// --- scoreItem ---

test("scoreItem ranks title overlap above note overlap", () => {
  const query = tokenize("repair checkout flow");
  const titleHit = scoreItem({ id: "a", title: "repair checkout flow", note: "unrelated" }, query);
  const noteHit = scoreItem({ id: "b", title: "unrelated", note: "repair checkout flow" }, query);
  assert.ok(titleHit > noteHit);
  assert.ok(titleHit <= 1 && noteHit >= 0);
});

test("scoreItem is 0 with no overlap, deterministic on ties", () => {
  const query = tokenize("zebra");
  assert.equal(scoreItem({ id: "a", title: "apple", note: "banana" }, query), 0);
  const q2 = tokenize("fix login");
  assert.equal(
    scoreItem({ id: "a", title: "fix login" }, q2),
    scoreItem({ id: "b", title: "fix login" }, q2),
  );
});

// --- findDuplicates ---

const items = [
  { id: "w1", title: "Repair the checkout flow", note: "cart totals are wrong", state: "claimed", owner: "quill" },
  { id: "w2", title: "Fix checkout totals", note: "", state: "unclaimed", owner: null },
  { id: "w3", title: "Write onboarding docs", note: "new member guide", state: "done", owner: "grok" },
  { id: "w4", title: "Checkout flow repair follow-up", note: "edge cases", state: "in_progress", owner: "instinct" },
];

test("findDuplicates ranks the closest matches first", () => {
  const out = findDuplicates(items, "repair checkout flow");
  const ids = out.map(d => d.id);
  assert.ok(ids.includes("w1") && ids.includes("w4"));
  assert.ok(!ids.includes("w3"));
  assert.equal(ids[0], "w1"); // exact title match wins
  // w2 shares only one token ("checkout") — below the default minScore, but
  // surfaces when the caller lowers the bar
  assert.ok(!ids.includes("w2"));
  assert.ok(findDuplicates(items, "repair checkout flow", { minScore: 0.1 }).some(d => d.id === "w2"));
  for (const d of out) {
    assert.ok(d.score >= 0.15 && d.score <= 1);
    assert.ok(Object.isFrozen(d));
  }
  assert.ok(Object.isFrozen(out));
});

test("findDuplicates respects limit, minScore and excludeId", () => {
  assert.ok(findDuplicates(items, "checkout", { limit: 1 }).length <= 1);
  const strict = findDuplicates(items, "checkout", { minScore: 0.99 });
  assert.deepEqual(strict, []);
  const excluded = findDuplicates(items, "repair checkout flow", { excludeId: "w1" });
  assert.ok(!excluded.some(d => d.id === "w1"));
  assert.ok(excluded.some(d => d.id === "w4"));
});

test("findDuplicates on an empty registry returns an empty list", () => {
  assert.deepEqual(findDuplicates([], "anything"), []);
});

test("findDuplicates validates inputs", () => {
  throwsCode(() => findDuplicates("nope", "q"), "invalid_duplicate_input");
  throwsCode(() => findDuplicates(items, ""), "invalid_duplicate_input");
  throwsCode(() => findDuplicates(items, "x".repeat(513)), "invalid_duplicate_input");
  throwsCode(() => findDuplicates(items, "q", { limit: 0 }), "invalid_duplicate_input");
  throwsCode(() => findDuplicates(items, "q", { limit: 21 }), "invalid_duplicate_input");
  throwsCode(() => findDuplicates(items, "q", { minScore: 2 }), "invalid_duplicate_input");
  throwsCode(() => findDuplicates([{ noId: true }], "q"), "invalid_duplicate_input");
});

test("findDuplicates tie-breaks by id for determinism", () => {
  const tied = [
    { id: "b", title: "fix login" },
    { id: "a", title: "fix login" },
  ];
  const out = findDuplicates(tied, "fix login");
  assert.deepEqual(out.map(d => d.id), ["a", "b"]);
});

// --- handler smoke test with fakes ---

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return {
    calls,
    json: (res, status, value) => { calls.push({ status, value }); return { status, value }; },
    reject,
    body: async req => req.body,
  };
};
const fakeAuth = memberId => ({ member: { id: memberId, kind: "agent", permissions: [] } });
const runDuplicates = async ({ query, limit, registry }) => {
  const helpers = fakeHelpers();
  const params = new URLSearchParams();
  if (query !== undefined) params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  const url = new URL(`https://room.example/api/rooms/room1/work-claims/duplicates?${params}`);
  const out = await handleWorkClaims({ req: { method: "GET", body: {} }, res: {}, url,
    store: {}, roomId: "room1", auth: fakeAuth("quill"), workClaimRoute: "duplicates",
    workClaimId: null, helpers, registry });
  return out;
};
const seed = async registry => {
  for (const item of items) {
    registry.set("room1", { ...item, owner: item.owner, history: [], claimedAt: null, leaseExpiresAt: null });
  }
};

test("handler: duplicates ranks registry claims for a query", async () => {
  const registry = createWorkClaimRegistry();
  await seed(registry);
  const out = await runDuplicates({ query: "repair checkout flow", registry });
  assert.equal(out.status, 200);
  assert.equal(out.value.roomId, "room1");
  assert.equal(out.value.query, "repair checkout flow");
  assert.equal(out.value.duplicates[0].id, "w1");
  assert.equal(out.value.duplicates[0].state, "claimed");
  assert.equal(out.value.duplicates[0].owner, "quill");
});

test("handler: duplicates validates q and limit", async () => {
  const registry = createWorkClaimRegistry();
  await seed(registry);
  const missing = await runDuplicates({ registry }).catch(error => error);
  assert.equal(missing.code, "invalid_claim_input"); // route-level shape check, like sibling routes
  assert.equal(missing.status, 422);
  const badLimit = await runDuplicates({ query: "checkout", limit: 99, registry }).catch(error => error);
  assert.equal(badLimit.code, "invalid_claim_input");
  const empty = await runDuplicates({ query: "zzz-no-such-thing", registry });
  assert.deepEqual(empty.value.duplicates, []);
});
