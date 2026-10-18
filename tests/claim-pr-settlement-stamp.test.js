// #3661: pullRequest.outcome is written only when the claim-prs poll
// settles a LIVE claim, so a claim finished by hand with deliveryMode
// "merged" carried an unverified assertion forever, and reads could not
// distinguish verified / asserted / pending / none.
// (1) Reads derive pullRequest.settlement at read time (never stored).
// (2) The tick spends its leftover candidate capacity and lookup budget,
// live claims first, on ONE verification lookup per done+merged claim:
// the outcome is stamped with a history note and no state transition; a
// pull found closed against the merged finish stamps "closed" and flags
// the contradiction on the record.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork, updateWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { pullRequestSettlement, withPullSettlement, recordPullOutcome } from "../server/claim-coordination.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { buildWorkClaimPage, handleWorkClaims } from "../server/work-claim-routes.mjs";

const NOW = Date.UTC(2026, 9, 16, 2, 0, 0);
const ROOM = "stamp-room";
const SHA = "d".repeat(40);
const pr = number => `https://github.com/Uuriko/project-room/pull/${number}`;

// A live claim holding a pull link, the way the board paths build one.
function linkedClaim(id, number, owner = "grok") {
  let item = claimWork(createWork({ id }, { now: NOW - 3600_000, agentId: owner }), owner,
    { now: NOW - 3600_000, leaseHours: null });
  item = appendWorkPullRequest(item, owner, {
    pullRequest: pr(number), expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: NOW - 3500_000
  });
  return item;
}

// The Pilot/EXP-10 shape: claimed, started, and finished by hand as merged.
function finishedMerged(id, number, owner = "grok") {
  let item = linkedClaim(id, number, owner);
  item = updateWork(item, owner, { state: "in_progress", now: NOW - 3000_000 });
  item = updateWork(item, owner, { state: "done", deliveryMode: "merged", now: NOW - 2000_000 });
  return item;
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  // STATUS-LEG (C-07): the tick also materializes the main-HEAD cache.
  // Seed it fresh (checked just past every nowMs these tests use) so the
  // deploy refresh is never due here — these tests count pull lookups,
  // and a not-due refresh makes no GitHub call.
  db.prepare("INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)")
    .run("_claim-main-head", JSON.stringify({ sha: SHA, behind: null, checkedAt: new Date(NOW + 60_000).toISOString() }), NOW);
  return { store: { db, workClaims: registry }, registry };
}

// A fetch double for the per-pull REST lookup only; anything else throws.
function pullFetch(bodies, calls) {
  return async url => {
    calls.push(String(url));
    const match = /\/pulls\/(\d+)$/.exec(String(url));
    const body = match ? bodies[Number(match[1])] : undefined;
    if (!body) throw new Error(`unexpected fetch: ${url}`);
    return {
      status: 200, ok: true,
      headers: { get: name => (name.toLowerCase() === "etag" ? (body.etag ?? null) : null) },
      text: async () => JSON.stringify(body), json: async () => body
    };
  };
}

const MERGED = { state: "closed", merged: true, merge_commit_sha: SHA, head: { sha: SHA }, etag: "\"v1\"" };

test("settlement derivation: verified / asserted / pending / none", () => {
  assert.equal(pullRequestSettlement(createWork({ id: "no-link" }, { now: NOW, agentId: "grok" })), "none",
    "no pull link at all");
  assert.equal(pullRequestSettlement(linkedClaim("live", 4101)), "pending",
    "live claim, link attached, outcome unknown");
  assert.equal(pullRequestSettlement(finishedMerged("asserted", 4102)), "asserted",
    "finished by hand as merged, never stamped");
  const stamped = recordPullOutcome(finishedMerged("verified", 4103), pr(4103), "merged", NOW);
  assert.equal(pullRequestSettlement(stamped), "verified", "the poller stamped the outcome");
  const stampedClosed = recordPullOutcome(linkedClaim("closed", 4104), pr(4104), "closed", NOW);
  assert.equal(pullRequestSettlement(stampedClosed), "verified",
    "a stamped closed outcome is verified too — verified names who stamped it, not the result");
  const resultFinish = updateWork(linkedClaim("result", 4105), "grok",
    { state: "in_progress", now: NOW - 3000_000 });
  const doneResult = updateWork(resultFinish, "grok", { state: "done", deliveryMode: "result", now: NOW - 2000_000 });
  assert.equal(pullRequestSettlement(doneResult), "pending",
    "done without a merged assertion: the outcome is simply unverified, and a link exists");
});

test("withPullSettlement attaches the derived state to the read copy only", () => {
  const stored = finishedMerged("copy", 4106);
  const read = withPullSettlement(stored);
  assert.equal(read.pullRequest.settlement, "asserted");
  assert.equal(stored.pullRequest.settlement, undefined, "the stored record is never rewritten by a read");
  const linkless = createWork({ id: "plain" }, { now: NOW, agentId: "grok" });
  assert.equal(withPullSettlement(linkless), linkless, "link-less claims pass through: pullRequest stays null (settlement none)");
});

test("the board page exposes settlement for every claim shape", () => {
  const verified = recordPullOutcome(finishedMerged("pg-verified", 4107), pr(4107), "merged", NOW);
  const asserted = finishedMerged("pg-asserted", 4108);
  const pending = linkedClaim("pg-pending", 4109);
  const none = createWork({ id: "pg-none" }, { now: NOW, agentId: "grok" });
  const page = buildWorkClaimPage([verified, asserted, pending, none], ROOM, "grok",
    new URLSearchParams(), NOW);
  const byId = new Map(page.claims.map(item => [item.id, item]));
  assert.equal(byId.get("pg-verified").pullRequest.settlement, "verified");
  assert.equal(byId.get("pg-asserted").pullRequest.settlement, "asserted");
  assert.equal(byId.get("pg-pending").pullRequest.settlement, "pending");
  assert.equal(byId.get("pg-none").pullRequest, null, "no link: pullRequest null, settlement none by absence");
  assert.equal(asserted.pullRequest.settlement, undefined, "the page builder did not mutate the stored items");
});

test("the single-claim read and the board list agree on settlement", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  store.workClaims.set("commons", finishedMerged("read-asserted", 4110));
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = (route, id) => handleWorkClaims({
    req: { method: "GET" }, res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: ["manage_claims"] } },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims
  });
  const read = await call("read", "read-asserted");
  assert.equal(read.value.pullRequest.settlement, "asserted");
  const list = await call("list");
  const listed = list.value.claims.find(item => item.id === "read-asserted");
  assert.equal(listed.pullRequest.settlement, "asserted");
  assert.equal(store.workClaims.get("commons", "read-asserted").pullRequest.settlement, undefined,
    "neither read wrote the derived field back to the stored record");
});

test("the tick verify-stamps a manually finished merged claim, with no state transition", async () => {
  const { store, registry } = setup();
  const before = finishedMerged("manual-merge", 4111);
  registry.set(ROOM, before);
  const calls = [];
  const out = await syncClaimPullRequests(store, {
    fetchImpl: pullFetch({ 4111: MERGED }, calls), nowMs: NOW, token: null
  });
  assert.equal(calls.length, 1, "exactly one verification lookup");
  assert.equal(out.checked, 1);
  assert.equal(out.updated, 0, "a verification stamp is not a settlement");
  const after = registry.get(ROOM, "manual-merge");
  assert.equal(after.state, "done", "no state transition");
  assert.equal(after.owner, before.owner, "owner untouched");
  assert.equal(after.deliveryMode, "merged");
  assert.equal(after.pullRequest.outcome, "merged");
  assert.equal(after.pullRequest.syncedAt, new Date(NOW).toISOString());
  assert.equal(after.pullRequest.etag, "\"v1\"", "the lookup's ETag is persisted with the stamp");
  assert.equal(after.history.length, before.history.length + 1, "history gains exactly the verification note");
  const note = after.history.at(-1);
  assert.equal(note.action, "pr_outcome_verified");
  assert.match(note.note, /4111/);
  assert.equal(pullRequestSettlement(after), "verified", "the read now derives verified");
  const calls2 = [];
  await syncClaimPullRequests(store, { fetchImpl: pullFetch({ 4111: MERGED }, calls2), nowMs: NOW + 60_000, token: null });
  assert.equal(calls2.length, 0, "a stamped claim leaves the verification class forever");
});

test("a closed-unmerged pull on a merged finish stamps closed and flags the contradiction", async () => {
  const { store, registry } = setup();
  registry.set(ROOM, finishedMerged("manual-lie", 4112));
  const calls = [];
  await syncClaimPullRequests(store, {
    fetchImpl: pullFetch({ 4112: { state: "closed", merged: false, head: { sha: SHA } } }, calls),
    nowMs: NOW, token: null
  });
  const after = registry.get(ROOM, "manual-lie");
  assert.equal(after.state, "done", "still no state transition");
  assert.equal(after.deliveryMode, "merged", "the finisher's assertion is not silently rewritten");
  assert.equal(after.pullRequest.outcome, "closed", "GitHub's terminal state is what gets stamped");
  const note = after.history.at(-1);
  assert.equal(note.action, "pr_outcome_contradiction");
  assert.match(note.note, /contradicts the merged finish/);
});

test("an open pull on a done claim backs off: no stamp, no history, no CI read", async () => {
  const { store, registry } = setup();
  const before = finishedMerged("manual-open", 4113);
  registry.set(ROOM, before);
  const calls = [];
  await syncClaimPullRequests(store, {
    fetchImpl: pullFetch({ 4113: { state: "open", merged: false, head: { sha: SHA } } }, calls),
    nowMs: NOW, token: null
  });
  assert.deepEqual(calls, ["https://api.github.com/repos/Uuriko/project-room/pulls/4113"],
    "one lookup and no CI read for a verification candidate");
  const after = registry.get(ROOM, "manual-open");
  assert.equal(after.pullRequest.outcome, null);
  assert.equal(after.history.length, before.history.length, "a non-terminal lookup stamps no history");
  assert.ok(after.pullRequest.nextPollAt > NOW, "the next verification waits out the poll backoff");
});

test("verification never starves live claims: the shared budget is spent live-first", async () => {
  const { store, registry } = setup();
  registry.set(ROOM, linkedClaim("live-first", 4114));
  registry.set(ROOM, finishedMerged("done-waits", 4115));
  const calls = [];
  const fetchImpl = pullFetch({
    4114: { state: "open", merged: false },
    4115: MERGED
  }, calls);
  // No token: one lookup per tick, and it must go to the live claim.
  await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW, token: null });
  assert.deepEqual(calls, ["https://api.github.com/repos/Uuriko/project-room/pulls/4114"]);
  assert.equal(registry.get(ROOM, "done-waits").pullRequest.outcome, null, "unstamped while the live claim holds the budget");
  // The live claim polled open and backed off; the next tick reaches the
  // verification candidate.
  await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW + 60_000, token: null });
  assert.deepEqual(calls.slice(1), ["https://api.github.com/repos/Uuriko/project-room/pulls/4115"]);
  assert.equal(registry.get(ROOM, "done-waits").pullRequest.outcome, "merged");
});

test("live candidates filling the 32-row cap leave no room for verification", async () => {
  const { store, registry } = setup();
  // 32 live claims sharing one pull URL (the collector dedupes by URL, so
  // the batch would have budget to spare — only the candidate cap can
  // keep the done claim out of this tick).
  for (let i = 0; i < 32; i += 1) registry.set(ROOM, linkedClaim(`cap-live-${i}`, 4116));
  registry.set(ROOM, finishedMerged("cap-done", 4117));
  const calls = [];
  await syncClaimPullRequests(store, {
    fetchImpl: pullFetch({ 4116: { state: "open", merged: false }, 4117: MERGED }, calls),
    nowMs: NOW, token: "t"
  });
  assert.deepEqual(calls, ["https://api.github.com/repos/Uuriko/project-room/pulls/4116"],
    "the done claim was never a candidate while live claims filled the cap");
  assert.equal(registry.get(ROOM, "cap-done").pullRequest.outcome, null);
});
