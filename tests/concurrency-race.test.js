// QA wave-2: true concurrency race tests with seeded data.
//
// Three races at the HTTP boundary — the layer the storage-level
// multiprocess claim race (tests/work-claim-multiprocess-race.test.js)
// cannot reach: concurrent claim attempts on one work item, concurrent
// message posts to one thread, concurrent joins for one member. Seeded room,
// seeded members, seeded work item — no dependence on live room state.
// Each race fires its requests with Promise.all (real overlap on the server
// event loop; the overlap assertion below proves the requests were in flight
// together rather than executed sequentially) and asserts the real invariant:
//
//  1. claim race: exactly one winner (200); every loser gets a clean 409
//     work_claim_conflict — never a 500, never a silent double-win; the
//     board shows one owner and exactly one claimed stamp.
//  2. message race: every post returns 201 with a distinct sequence; all
//     bodies are retrievable from the conversation — no lost messages, no
//     duplicates.
//  3. join race: exactly one member.added succeeds (201); every duplicate
//     gets a clean 409; the room holds exactly one new membership.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contracts: single-winner claims, lossless concurrent posts,
//    duplicate-free joins — at the HTTP transport boundary, under true
//    concurrency.
// 2. Credible regressions: a refactor that moves the claim state check out of
//    the registry transaction (or drops it), a torn write in the command
//    path, or a weakened member-exists check. Each passes every sequential
//    test and only shows under concurrency.
// 3. Existing coverage: work-claim-multiprocess-race proves the storage-layer
//    claim race across OS processes; nothing exercises the HTTP claim route,
//    concurrent message posts, or concurrent joins.
// 4. No test-only seam: the production HTTP routes, store.command, and the
//    real SQLite store are the surfaces under test.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "commons";

async function fixture(t) {
  // File DB under the worktree .tmp (never /tmp, never prod), mirroring the
  // production storage discipline via RoomStore itself.
  const dir = join(dirname(fileURLToPath(import.meta.url)), ".tmp", `concurrency-race-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const store = new RoomStore(join(dir, "race.sqlite"));
  store.initialize(initialRoom(ROOM));
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const startedAt = Date.now();
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value, startedAt, endedAt: Date.now() };
  };
  const enroll = async name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    store.identities.link(ownerKey, ROOM, {
      identityId: identity.identityId, memberId, displayName: name,
      permissions: ["accept_work", "complete_work"],
    });
    return { memberId, key: store.issueAccessKey(ROOM, memberId) };
  };
  return { store, ownerKey, call, enroll };
}

// True-concurrency proof: every request in the batch must have started
// before the first one finished. A sequential simulation (await in a loop)
// fails this; Promise.all over live requests passes it.
function assertOverlapped(results, label) {
  const firstEnd = Math.min(...results.map(r => r.endedAt));
  const startedBeforeFirstEnd = results.filter(r => r.startedAt < firstEnd).length;
  assert.ok(
    startedBeforeFirstEnd > 1,
    `${label}: requests did not overlap in flight ` +
    `(${startedBeforeFirstEnd}/${results.length} started before the first finished) — not a real race`,
  );
}

test("claim race: concurrent claims on one work item produce exactly one winner", { timeout: 120000 }, async t => {
  const { ownerKey, call, enroll } = await fixture(t);
  const created = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
    { id: "race-target", title: "Race target" });
  assert.equal(created.status, 201, `seed claim create failed: ${JSON.stringify(created.value).slice(0, 200)}`);

  const RACERS = 8;
  const racers = [];
  for (let i = 0; i < RACERS; i++) racers.push(await enroll(`Race Agent ${i}`));

  const attempts = await Promise.all(racers.map((racer, i) =>
    call("POST", `/api/rooms/${ROOM}/work-claims/race-target/claim`, racer.key, { note: `racer-${i}` })));
  assertOverlapped(attempts, "claim race");

  const winners = attempts.filter(a => a.status === 200);
  const losers = attempts.filter(a => a.status !== 200);
  assert.equal(winners.length, 1,
    `exactly one claim winner, got ${winners.length}: [${attempts.map(a => a.status).join(", ")}]`);
  assert.equal(losers.length, RACERS - 1);
  for (const loser of losers) {
    assert.equal(loser.status, 409,
      `loser must get a clean 409, got ${loser.status}: ${JSON.stringify(loser.value).slice(0, 200)}`);
    assert.equal(loser.value?.error?.code, "work_claim_conflict",
      `loser code must be work_claim_conflict: ${JSON.stringify(loser.value).slice(0, 200)}`);
  }
  const winnerId = winners[0].value.owner;
  assert.ok(racers.some(r => r.memberId === winnerId), `winner ${winnerId} is one of the racers`);

  // Board read-back: one owner, exactly one claimed stamp naming the winner,
  // no phantom winners.
  const board = await call("GET", `/api/rooms/${ROOM}/work-claims/race-target`, ownerKey);
  assert.equal(board.status, 200);
  assert.equal(board.value.owner, winnerId, "board owner is the race winner");
  const claimedStamps = (board.value.history ?? []).filter(h => h.action === "claimed");
  assert.equal(claimedStamps.length, 1, "exactly one claimed stamp in history");
  assert.equal(claimedStamps[0].agentId, winnerId, "the claimed stamp names the winner");
});

test("message race: concurrent posts to one thread lose nothing", { timeout: 120000 }, async t => {
  const { ownerKey, call, enroll } = await fixture(t);
  const parent = await call("POST", `/api/rooms/${ROOM}/commands`, ownerKey, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "race-parent", body: "race parent" },
  });
  assert.equal(parent.status, 201, `seed parent post failed: ${JSON.stringify(parent.value).slice(0, 200)}`);

  const AGENTS = 8;
  const PER_AGENT = 5; // 5 < 30: stays under the per-member flood burst
  const posters = [];
  for (let i = 0; i < AGENTS; i++) posters.push(await enroll(`Post Agent ${i}`));

  const expected = [];
  const sends = [];
  for (let i = 0; i < AGENTS; i++) {
    for (let j = 0; j < PER_AGENT; j++) {
      const body = `race message ${i}-${j}`;
      expected.push(body);
      sends.push(call("POST", `/api/rooms/${ROOM}/commands`, posters[i].key, {
        id: randomUUID(), type: "message.posted",
        data: { messageId: `race-m-${i}-${j}`, body, replyToId: "race-parent" },
      }));
    }
  }
  const results = await Promise.all(sends);
  assertOverlapped(results, "message race");

  for (const r of results) {
    assert.equal(r.status, 201,
      `every post must succeed, got ${r.status}: ${JSON.stringify(r.value).slice(0, 200)}`);
  }
  const sequences = results.map(r => r.value.sequence);
  assert.equal(new Set(sequences).size, results.length, "every post got a distinct sequence");

  // Read-back through the real conversation surface: every body present.
  const convo = await call("GET", `/api/rooms/${ROOM}/conversation?limit=100`, ownerKey);
  assert.equal(convo.status, 200);
  const bodies = (convo.value.messages ?? []).map(m => m.body);
  for (const body of expected) assert.ok(bodies.includes(body), `lost message: ${body}`);
  assert.equal(new Set(bodies).size, bodies.length, "no duplicate message bodies");
});

test("join race: concurrent joins for one member produce exactly one membership", { timeout: 120000 }, async t => {
  const { store, ownerKey, call } = await fixture(t);
  const before = Object.keys(store.room(ROOM).state.members).length;

  const RACERS = 8;
  const joins = await Promise.all(Array.from({ length: RACERS }, () =>
    call("POST", `/api/rooms/${ROOM}/commands`, ownerKey, {
      id: randomUUID(), type: "member.added",
      data: {
        memberId: "race-joiner", displayName: "Race Joiner", kind: "agent",
        permissions: ["accept_work", "complete_work"],
      },
    })));
  assertOverlapped(joins, "join race");

  const wins = joins.filter(j => j.status === 201);
  const dups = joins.filter(j => j.status !== 201);
  assert.equal(wins.length, 1,
    `exactly one join succeeds, got ${wins.length}: [${joins.map(j => j.status).join(", ")}]`);
  assert.equal(dups.length, RACERS - 1);
  for (const dup of dups) {
    assert.equal(dup.status, 409,
      `duplicate join must get a clean 409, got ${dup.status}: ${JSON.stringify(dup.value).slice(0, 200)}`);
    assert.match(JSON.stringify(dup.value), /Member already exists/,
      `duplicate join refusal must name the conflict: ${JSON.stringify(dup.value).slice(0, 200)}`);
  }
  const members = store.room(ROOM).state.members;
  assert.equal(Object.keys(members).length, before + 1, "exactly one membership added");
  assert.ok(Object.hasOwn(members, "race-joiner"), "the winner holds the membership");
});
