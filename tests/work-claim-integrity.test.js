// SEC-2 and Q3-A Board integrity, at the claim route with a real RoomStore
// (and the real HTTP server where request volume stays under the write
// limit): reviewers-only notes, sweep authority, server-owned PR facts,
// the history cap, done-claim paging, content-trust markers, the room
// event budget, the cached deploy status, text normalization and inputs.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { MAX_CLAIM_HISTORY, claimWork, createWork, updateWork } from "../server/work-claims.mjs";
import { CONTENT_TRUST } from "../server/content-trust.mjs";
import { readClaimPullBudget, writeClaimPullBudget } from "../server/claim-pr-sync.mjs";
import {
  boardText, clientPullRequestInput, assertBoardLeaseHours, assertDependsOnKnown, assertBoardEventBudget,
  roomEventsRemaining, BOARD_LEASE_HOURS_MAX, EVENT_BUDGET_RESERVE
} from "../server/work-claim-integrity.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function roomFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions }
  });
  add("contrib", "agent", ["accept_work", "complete_work"]);
  add("chatter", "agent", []);
  add("reviewer", "agent", ["verify"]);
  add("manager", "agent", ["manage_claims"]);
  add("writer", "agent", ["write_external"]);
  t.after(() => store.close());
  const events = () => store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='work_claim.updated'").get().n;
  const call = async (memberId, route, { id = null, body = undefined, query = "", fetchPullRequest = null } = {}) => {
    const method = body === undefined ? "GET" : "POST";
    try {
      const out = await handleWorkClaims({
        req: { method, body },
        res: {},
        url: new URL(`https://room.example/api/rooms/commons/work-claims${query}`),
        store, roomId: "commons",
        auth: { member: { id: memberId, kind: "agent", permissions: [] } },
        workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
        ...(fetchPullRequest ? { fetchPullRequest, githubToken: "test-token" } : {}),
      });
      return { status: out.status, code: out.value?.error?.code ?? null, value: out.value };
    } catch (error) {
      if (!Number.isInteger(error.status)) throw error;
      return { status: error.status, code: error.code, message: error.message };
    }
  };
  return { store, call, events };
}

const created = async (f, id, by = "owner", extra = {}) => {
  const out = await f.call(by, "create", { body: { id, title: id, files: [`src/${id}.mjs`], ...extra } });
  assert.equal(out.status, 201, `${id}: ${out.code} ${out.message ?? ""}`);
  return out.value;
};
const held = async (f, id, by = "contrib") => {
  await created(f, id);
  const out = await f.call(by, "claim", { id, body: { leaseHours: 2 } });
  assert.equal(out.status, 200, `${id}: ${out.code} ${out.message ?? ""}`);
  return out.value;
};

// Seed a Board with 431 done claims (400 recent + 30 old + 1 dependency
// target) shared by the list/paging test and the quarantined p95 perf test.
function seedBoardClaims(f) {
  const dayMs = 86_400_000;
  const seed = (id, atMs) => {
    let item = createWork({ id, title: id }, { now: atMs, agentId: "owner" });
    item = claimWork(item, "owner", { now: atMs, leaseHours: 1 });
    item = updateWork(item, "owner", { state: "in_progress", now: atMs });
    for (let i = 0; i < 20; i++) item = updateWork(item, "owner", { note: `step ${i}`, now: atMs });
    item = updateWork(item, "owner", { state: "done", note: "finished", now: atMs });
    f.store.workClaims.set("commons", item);
  };
  for (let i = 0; i < 400; i++) seed(`done-${String(i).padStart(3, "0")}`, Date.now() - dayMs);
  for (let i = 0; i < 30; i++) seed(`old-${i}`, Date.now() - 30 * dayMs);
  seed("needed", Date.now() - 30 * dayMs);
}

test("review notes come from reviewers, the owner, or claim managers", async t => {
  const f = roomFixture(t);
  await held(f, "noted");
  for (const memberId of ["contrib", "chatter", "writer"]) {
    const refused = await f.call(memberId, "review", { id: "noted", body: { note: "looks fine" } });
    assert.equal(refused.status, 403, memberId);
    assert.equal(refused.code, "work_claims_not_permitted", memberId);
  }
  for (const memberId of ["owner", "reviewer", "manager"]) {
    const allowed = await f.call(memberId, "review", { id: "noted", body: { note: `checked by ${memberId}` } });
    assert.equal(allowed.status, 200, memberId);
    assert.ok(allowed.value.attestations.some(entry => entry.memberId === memberId), memberId);
  }
  // A verdict review still refuses the claim holder.
  const self = await f.call("contrib", "review", { id: "noted", body: { verdict: "approve", summary: "mine" } });
  assert.equal(self.status, 403);
});

test("100 notes from one reviewer on one claim revision produce one room event", async t => {
  const f = roomFixture(t);
  await held(f, "dedupe");
  const before = f.events();
  let last;
  for (let i = 0; i < 100; i++) {
    last = await f.call("reviewer", "review", { id: "dedupe", body: { note: `pass ${i}` } });
    assert.equal(last.status, 200);
  }
  assert.equal(f.events() - before, 1);
  const stored = f.store.workClaims.get("commons", "dedupe");
  const mine = stored.attestations.filter(entry => entry.memberId === "reviewer");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].note, "pass 99", "the latest note replaces the earlier one");
  assert.equal(stored.history.filter(entry => entry.action === "reviewed").length, 1);
});

test("50 rapid note updates on one claim produce at most 2 room events", async t => {
  const f = roomFixture(t);
  await held(f, "chatty");
  const before = f.events();
  for (let i = 0; i < 50; i++) {
    const out = await f.call("contrib", "update", { id: "chatty", body: { note: `progress ${i}` } });
    assert.equal(out.status, 200);
  }
  assert.ok(f.events() - before <= 2, `events +${f.events() - before}`);
  // A state transition is never coalesced.
  const started = await f.call("contrib", "update", { id: "chatty", body: { state: "in_progress" } });
  assert.equal(started.status, 200);
  const last = f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 1").get();
  assert.equal(JSON.parse(last.body).data.claimState, "in_progress");
});

test("sweep is for Board writers, claim managers and the owner, and refuses before any GitHub read", async t => {
  const f = roomFixture(t);
  let fetches = 0;
  const fetchPullRequest = async () => { fetches += 1; throw new Error("no network in tests"); };
  await created(f, "linked", "owner", { pullRequest: "https://github.com/example/repo/pull/7" });
  await f.call("contrib", "claim", { id: "linked", body: { leaseHours: 2 } });
  for (const memberId of ["chatter", "writer"]) {
    const refused = await f.call(memberId, "sweep", { body: {}, fetchPullRequest });
    assert.equal(refused.status, 403, memberId);
    assert.equal(refused.code, "work_claims_not_permitted", memberId);
  }
  assert.equal(fetches, 0, "a refused sweep never polls GitHub");
  for (const memberId of ["owner", "contrib", "reviewer", "manager"]) {
    const allowed = await f.call(memberId, "sweep", { body: {} });
    assert.equal(allowed.status, 200, memberId);
  }
});

test("pull request outcome, CI and head facts are refused from clients", async t => {
  const f = roomFixture(t);
  for (const [field, extra] of [
    ["outcome", { outcome: "merged" }],
    ["merged", { merged: true }],
    ["ci", { ci: { state: "success" } }],
    ["mergeable", { mergeable: true }],
    ["headSha", { headSha: "a".repeat(40) }],
  ]) {
    const refused = await f.call("contrib", "create", { body: { id: `forged-${field}`, pullRequest: { url: "https://github.com/example/repo/pull/1", ...extra } } });
    assert.equal(refused.status, 422, field);
    assert.equal(refused.code, "invalid_claim_input", field);
    assert.match(refused.message, new RegExp(`pullRequest\\.${field}`));
    assert.equal(f.store.workClaims.get("commons", `forged-${field}`), null);
  }
  const listed = await f.call("contrib", "create", { body: { id: "forged-list", pullRequests: [{ url: "https://github.com/example/repo/pull/2", outcome: "merged" }] } });
  assert.equal(listed.status, 422);
  // A reference by URL object, URL string, or owner/repo#number is accepted.
  const object = await created(f, "by-object", "contrib", { pullRequest: { url: "https://github.com/example/repo/pull/3" } });
  assert.equal(object.pullRequest.outcome, null);
  const short = await created(f, "by-short", "contrib", { pullRequest: "example/repo#4" });
  assert.equal(short.pullRequest.url, "https://github.com/example/repo/pull/4");
  // A non-writer is refused before input checks.
  const chat = await f.call("chatter", "create", { body: { id: "chat-forged", pullRequest: { url: "https://github.com/example/repo/pull/5", outcome: "merged" } } });
  assert.equal(chat.status, 403);
});

test("claim history keeps 200 entries and the PR link precondition counts the dropped ones", async t => {
  const f = roomFixture(t);
  let item = createWork({ id: "long" }, { agentId: "owner" });
  item = claimWork(item, "contrib", { leaseHours: 2 });
  for (let i = 0; i < 260; i++) item = updateWork(item, "contrib", { note: `n${i}` });
  f.store.workClaims.set("commons", item);
  const stored = f.store.workClaims.get("commons", "long");
  assert.equal(stored.history.length, MAX_CLAIM_HISTORY);
  assert.equal(stored.historyOmitted, 262 - MAX_CLAIM_HISTORY);
  assert.equal(stored.history.at(-1).note, "n259");
  const linked = await f.call("contrib", "update", { id: "long", body: {
    appendPullRequest: "https://github.com/example/repo/pull/9",
    expectedClaimedAt: stored.claimedAt,
    expectedHistoryLength: stored.history.length + stored.historyOmitted,
  } });
  assert.equal(linked.status, 200, linked.code);
  assert.equal(linked.value.historyOmitted, stored.historyOmitted + 1);
});

test("the Board list pages done claims by age and summarizes history", async t => {
  const f = roomFixture(t);
  seedBoardClaims(f);
  await created(f, "waiting", "owner", { dependsOn: ["needed"] });

  await f.call("owner", "list", { query: "?limit=200" });
  const page = await f.call("owner", "list", { query: "?limit=50" });
  const bytes = Buffer.byteLength(JSON.stringify(page.value));
  assert.ok(bytes < 64 * 1024, `a 50-claim page is ${bytes} bytes`);
  assert.equal(page.value.olderDone, 30, "done claims older than 7 days leave the default list");
  assert.equal(page.value.olderDoneQuery, "state=done");
  for (const claim of page.value.claims) {
    assert.ok(claim.history.length <= 3, "list entries carry a history summary");
    if (claim.state === "done") assert.equal(claim.history.length + claim.historyOmitted, 24);
  }
  const ids = [];
  let cursor = null;
  do {
    const next = await f.call("owner", "list", { query: `?limit=200${cursor ? `&cursor=${cursor}` : ""}` });
    ids.push(...next.value.claims.map(claim => claim.id));
    cursor = next.value.nextCursor;
  } while (cursor);
  assert.ok(ids.includes("needed"), "a done claim an open claim depends on stays listed");
  assert.ok(!ids.some(id => id.startsWith("old-")));
  const done = [];
  cursor = null;
  do {
    const next = await f.call("owner", "list", { query: `?state=done&limit=200${cursor ? `&cursor=${cursor}` : ""}` });
    assert.equal(next.value.state, "done");
    done.push(...next.value.claims);
    cursor = next.value.nextCursor;
  } while (cursor);
  assert.equal(done.length, 431, "?state=done pages through every done claim");
  assert.ok(done.every(claim => claim.state === "done"));
  const full = await f.call("owner", "read", { id: "done-000" });
  assert.equal(full.value.history.length, 24, "the single-claim read returns the stored history");
  assert.equal((await f.call("owner", "list", { query: "?state=finished" })).status, 422);
});

// QUARANTINED — see tests/quarantine.json and docs/FLAKY-QUARANTINE.md.
// The p95 timing assertion below flakes on loaded/slow VMs (it fails on
// pristine main), so it is skipped in the blocking suite and runs only in
// the non-blocking quarantine lane (`npm run test:quarantined`, which sets
// QUARANTINE_RUN=1).
const QUARANTINE_RUN = process.env.QUARANTINE_RUN === "1";

test("the Board list endpoint p95 stays under the 50 ms budget", { skip: !QUARANTINE_RUN }, async t => {
  const f = roomFixture(t);
  seedBoardClaims(f);
  await f.call("owner", "list", { query: "?limit=200" }); // warm-up
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    await f.call("owner", "list", { query: "?limit=50" });
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.ceil(samples.length * 0.95) - 1] < 50, `list p95 ${samples.at(-1).toFixed(1)} ms`);
});

test("Board reads mark another member's claim text untrusted and never the reader's own", async t => {
  const f = roomFixture(t);
  await held(f, "theirs");
  await f.call("reviewer", "review", { id: "theirs", body: { note: "SENTINEL from the reviewer" } });
  await created(f, "mine", "owner");
  const list = await f.call("owner", "list");
  assert.equal(list.value.contentTrust, CONTENT_TRUST);
  const theirs = list.value.claims.find(claim => claim.id === "theirs");
  const mine = list.value.claims.find(claim => claim.id === "mine");
  assert.equal(mine.untrusted, undefined, "the reader's own claim is not marked");
  assert.ok(mine.history.every(entry => entry.untrusted === undefined));
  const note = theirs.history.find(entry => entry.note === "SENTINEL from the reviewer");
  assert.equal(note.untrusted, true);
  assert.equal(theirs.attestations.find(entry => entry.memberId === "reviewer").untrusted, true);
  const read = await f.call("owner", "read", { id: "theirs" });
  assert.equal(read.value.contentTrust, CONTENT_TRUST);
  assert.equal(read.value.history.find(entry => entry.note === "SENTINEL from the reviewer").untrusted, true);
  const asReviewer = await f.call("reviewer", "read", { id: "theirs" });
  assert.equal(asReviewer.value.history.find(entry => entry.note === "SENTINEL from the reviewer").untrusted, undefined);
});

test("with under 10% of the event budget left only the owner and claim managers write", async t => {
  const f = roomFixture(t);
  await held(f, "budget");
  const nearlyFull = Math.ceil(PILOT_LIMITS.eventsPerRoom * 0.9) + 1;
  f.store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(nearlyFull);
  const refused = await f.call("contrib", "create", { body: { id: "late" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "room_event_budget_low");
  assert.equal(refused.value.eventsRemaining, PILOT_LIMITS.eventsPerRoom - nearlyFull);
  const note = await f.call("contrib", "update", { id: "budget", body: { note: "still here" } });
  assert.equal(note.status, 409);
  assert.equal((await f.call("owner", "create", { body: { id: "owner-late", files: ["src/owner-late.mjs"] } })).status, 201);
  assert.equal((await f.call("manager", "release", { id: "budget", body: { reason: "winding down" } })).status, 200);
  const status = await f.call("chatter", "status");
  assert.equal(status.value.eventsRemaining, PILOT_LIMITS.eventsPerRoom - f.store.room("commons").sequence);
});

// QA200-CH-2033 (4th probe against the #2033 ledger): the member-triggered
// sweep settles PR links and records CI facts, which emit work_claim.updated
// room events — it is a Board write, so the event-budget floor must refuse it
// for non-privileged writers exactly like create/claim/update do.
test("with under 10% of the event budget left a writer's sweep is refused and emits no events", async t => {
  const f = roomFixture(t);
  await held(f, "sweepy");
  const read = await f.call("contrib", "read", { id: "sweepy" });
  assert.equal(read.status, 200);
  const linked = await f.call("contrib", "update", { id: "sweepy", body: {
    appendPullRequest: "https://github.com/octo/repo/pull/7",
    expectedClaimedAt: read.value.claimedAt,
    expectedHistoryLength: read.value.history.length,
  } });
  assert.equal(linked.status, 200, `${linked.code} ${linked.message ?? ""}`);
  const nearlyFull = Math.ceil(PILOT_LIMITS.eventsPerRoom * 0.9) + 1;
  f.store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(nearlyFull);
  // GitHub says the linked PR merged: without the gate the sweep settles the
  // claim and emits a pr_merged room event past the floor.
  const mergedDoc = { state: "closed", merged: true, merge_commit_sha: "b".repeat(40), head: { sha: "a".repeat(40) } };
  const fetchPullRequest = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify(mergedDoc), json: async () => mergedDoc,
  });
  const before = f.events();
  const swept = await f.call("contrib", "sweep", { body: {}, fetchPullRequest });
  assert.equal(swept.status, 409);
  assert.equal(swept.code, "room_event_budget_low");
  assert.equal(f.events(), before, "no room events past the floor");
  const stored = f.store.workClaims.get("commons", "sweepy");
  assert.equal(stored.state, "claimed", "the PR settlement did not land");
  // Privileged writers can still sweep to wind the room down.
  const ownerSweep = await f.call("owner", "sweep", { body: {}, fetchPullRequest });
  assert.equal(ownerSweep.status, 200);
  assert.equal(ownerSweep.value.pullRequests.updated, 1);
  assert.equal(f.events(), before + 1);
});

test("deploy status is fetched at most once per 60 s, and only writers can refresh", async t => {
  const f = roomFixture(t);
  let fetches = 0;
  const fetchPullRequest = async () => {
    fetches += 1;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ sha: "c".repeat(40) }), json: async () => ({ sha: "c".repeat(40) }) };
  };
  const reads = await Promise.all(Array.from({ length: 20 }, () => f.call("chatter", "status", { fetchPullRequest })));
  for (let i = 0; i < 180; i++) reads.push(await f.call("chatter", "status", { fetchPullRequest }));
  assert.ok(reads.every(read => read.status === 200 && read.value.main === "c".repeat(40) && read.value.stale === false));
  assert.equal(fetches, 1, "200 reads share one GitHub request");
  await f.call("chatter", "status", { fetchPullRequest, query: "?refresh=1" });
  assert.equal(fetches, 1, "a read-only member cannot force a refresh");
  await f.call("contrib", "status", { fetchPullRequest, query: "?refresh=1" });
  assert.equal(fetches, 2, "a Board writer can");
  // While the GitHub budget is held, status is the stale cached value.
  writeClaimPullBudget(f.store, Date.now() + 600_000, Date.now());
  const heldUntil = readClaimPullBudget(f.store);
  assert.ok(heldUntil > Date.now());
  const held = await f.call("contrib", "status", { fetchPullRequest, query: "?refresh=1" });
  assert.equal(held.value.stale, true);
  assert.equal(held.value.heldUntil, new Date(heldUntil).toISOString());
  assert.equal(held.value.main, "c".repeat(40));
  assert.equal(fetches, 2);
});

test("titles and notes are normalized and refuse control, bidi, unpaired and invisible-only text", async t => {
  const f = roomFixture(t);
  const refusedTitles = ["bad\u0000nul", "tab\there", "line\nbreak", "esc\u001b", "c1\u0085", "rlo\u202Eevil", "iso\u2066x", "lone\uD800", "   ", "\u200B\u200D\uFEFF", "\u00A0\u3000"];
  for (const [index, title] of refusedTitles.entries()) {
    const out = await f.call("contrib", "create", { body: { id: `bad-${index}`, title } });
    assert.equal(out.status, 422, JSON.stringify(title));
    assert.equal(out.code, "invalid_claim_input");
    assert.match(out.message, /^title:/);
  }
  for (const [index, title] of ["修复登录流程", "Ship it 🚀👩‍💻", "Crème brûlée café", "Ελληνικά", "עברית"].entries()) {
    const out = await f.call("contrib", "create", { body: { id: `ok-${index}`, title, files: [`src/ok-${index}.mjs`] } });
    assert.equal(out.status, 201, title);
    assert.equal(out.value.title, title.normalize("NFC"));
  }
  const decomposed = await f.call("contrib", "create", { body: { id: "nfc", title: "Cafe\u0301", files: ["src/nfc.mjs"] } });
  assert.equal(decomposed.value.title, "Caf\u00E9");
  await f.call("contrib", "claim", { id: "nfc", body: { leaseHours: 1 } });
  const multi = await f.call("contrib", "update", { id: "nfc", body: { note: "line one\r\nline two" } });
  assert.equal(multi.status, 200);
  assert.equal(multi.value.history.at(-1).note, "line one\nline two");
  for (const note of ["", "  \n ", "bell\u0007", "rlo\u202E"]) {
    const out = await f.call("contrib", "update", { id: "nfc", body: { note } });
    assert.equal(out.status, 422, JSON.stringify(note));
    assert.match(out.message, /^note:/);
  }
  const emptyReview = await f.call("reviewer", "review", { id: "nfc", body: { note: " " } });
  assert.equal(emptyReview.status, 422);
  assert.equal((await f.call("reviewer", "review", { id: "nfc", body: {} })).status, 200, "a review note stays optional");
});

test("dependsOn must name claims in this room and leaseHours is 1 minute to 2h", async t => {
  const f = roomFixture(t);
  await created(f, "base");
  const dangling = await f.call("contrib", "create", { body: { id: "child", dependsOn: ["base", "ghost"] } });
  assert.equal(dangling.status, 422);
  assert.match(dangling.message, /^dependsOn:.*ghost/);
  assert.equal((await f.call("contrib", "create", { body: { id: "child", dependsOn: ["base"], files: ["src/child.mjs"] } })).status, 201);
  for (const leaseHours of [0.0001, 0.01, 3, "2"]) {
    const out = await f.call("contrib", "claim", { id: "base", body: { leaseHours } });
    assert.equal(out.status, 422, String(leaseHours));
    assert.match(out.message, /leaseHours/);
  }
  assert.equal((await f.call("contrib", "claim", { id: "base", body: { leaseHours: 0.25 } })).status, 200);
});

test("over real HTTP a guest's review note and sweep are refused and the list is marked", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-guest", type: "member.added", data: { memberId: "guest", displayName: "Guest", kind: "agent", permissions: [] } });
  const guestKey = store.issueAccessKey("commons", "guest");
  const server = createRoomServer({ store });
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
  assert.equal((await call(ownerKey, "/work-claims", { id: "http-claim", title: "HTTP claim", files: ["src/http-claim.mjs"] })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims/http-claim/claim", { leaseHours: 1 })).status, 200);
  const note = await call(guestKey, "/work-claims/http-claim/review", { note: "guest note" });
  assert.equal(note.status, 403);
  assert.equal(note.value.error.code, "work_claims_not_permitted");
  assert.equal((await call(guestKey, "/work-claims/sweep", {})).status, 403);
  const forged = await call(ownerKey, "/work-claims", { id: "forged", pullRequest: { url: "https://github.com/example/repo/pull/1", outcome: "merged" } });
  assert.equal(forged.status, 422);
  assert.equal(forged.value.error.code, "invalid_claim_input");
  const list = await call(guestKey, "/work-claims");
  assert.equal(list.status, 200);
  assert.equal(list.value.contentTrust, CONTENT_TRUST);
  assert.equal(list.value.claims[0].untrusted, true);
  const status = await call(guestKey, "/work-claims/status");
  assert.equal(status.status, 200);
  assert.equal(typeof status.value.eventsRemaining, "number");
  assert.equal(status.value.stale, false);
});

// The pure input rules the routes apply before the claim state machine runs.
test("board input rules: text normalization, client PR facts, lease bounds, dependencies and the event budget", () => {
  const reject = (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; };
  assert.equal(boardText(reject, "title", "Cafe\u0301"), "Caf\u00e9");
  assert.equal(boardText(reject, "note", "a\r\nb", { multiline: true }), "a\nb");
  assert.equal(boardText(reject, "title", undefined), undefined);
  for (const bad of ["a\u0007b", "\u202Eevil", "\u200B \u200B", "\uD800x"]) {
    assert.throws(() => boardText(reject, "title", bad), { status: 422, code: "invalid_claim_input" }, JSON.stringify(bad));
  }
  assert.deepEqual(clientPullRequestInput(reject, { pullRequest: "Uuriko/project-room#12" }),
    { pullRequest: "https://github.com/Uuriko/project-room/pull/12" });
  assert.deepEqual(clientPullRequestInput(reject, { pullRequests: [{ url: "o/r#3" }] }), { pullRequests: [{ url: "https://github.com/o/r/pull/3" }] });
  assert.throws(() => clientPullRequestInput(reject, { pullRequest: { url: "o/r#3", merged: true } }), /pullRequest\.merged: is recorded by the server/);
  assert.doesNotThrow(() => assertBoardLeaseHours(reject, { leaseHours: BOARD_LEASE_HOURS_MAX }));
  // The immortal null opt-out is retired: null is rejected, not allowed.
  assert.throws(() => assertBoardLeaseHours(reject, { leaseHours: null }), { code: "claim_lease_required" });
  assert.throws(() => assertBoardLeaseHours(reject, { leaseHours: BOARD_LEASE_HOURS_MAX + 1 }), { code: "claim_lease_too_long" });
  assert.throws(() => assertBoardLeaseHours(reject, { leaseHours: "4" }), { code: "invalid_claim_input" });
  const known = new Set(["a"]);
  assert.doesNotThrow(() => assertDependsOnKnown(reject, { dependsOn: ["a"] }, { selfId: "b", has: id => known.has(id) }));
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ["b"] }, { selfId: "b", has: id => known.has(id) }), /cannot depend on itself/);
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ["zz"] }, { selfId: "b", has: id => known.has(id) }), /no claim "zz"/);
  const limit = PILOT_LIMITS.eventsPerRoom;
  assert.equal(roomEventsRemaining(limit - 5), 5);
  const low = limit - Math.floor(limit * EVENT_BUDGET_RESERVE) + 1;
  assert.throws(() => assertBoardEventBudget(low, { privileged: false }), error => error.status === 409 && error.code === "room_event_budget_low");
  assert.doesNotThrow(() => assertBoardEventBudget(low, { privileged: true }));
  assert.doesNotThrow(() => assertBoardEventBudget(1, { privileged: false }));
});
