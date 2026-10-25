// Open pull requests are a throughput signal. Crossing the cap (default 5)
// still claims, assigns, and links. The response tells the agent to finish,
// rebase, or land, and wakes someone who can reassign.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import {
  openPullsFor, openPrThroughput, coordinatorsFor, DEFAULT_OPEN_PR_CAP,
} from "../server/pr-throughput.mjs";

const T0 = Date.parse("2026-10-25T12:00:00.000Z");
const pr = n => `https://github.com/Uuriko/project-room/pull/${n}`;

function held(id, owner, number, outcome) {
  const pull = outcome ? { url: pr(number), outcome } : pr(number);
  return claimWork(createWork({ id, title: id, pullRequest: pull }, { now: T0, agentId: owner }), owner, { now: T0 });
}

const authority = {
  ownerId: "owner",
  members: {
    owner: { active: true, permissions: ["manage_claims"] },
    quill: { active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
    sage: { active: true, permissions: ["manage_claims"] },
    old: { active: false, permissions: ["manage_claims"] },
    grok: { active: true, permissions: ["accept_work"] },
  },
};

test("open pulls count once, and merged or closed pulls do not count", () => {
  const claims = [
    held("a", "quill", 1),
    held("b", "quill", 1),
    held("c", "quill", 2, "merged"),
    held("d", "quill", 3, "closed"),
    held("e", "grok", 4),
    { owner: "quill", pullRequests: [], pullRequest: pr(5) },
    { owner: "quill", pullRequests: [{ url: pr(6), outcome: "merged" }], pullRequest: pr(7) },
    { owner: "quill", pullRequest: "https://example.com/pull/8" },
    { owner: "quill", pullRequest: `${pr(9)}/` },
  ];
  const pulls = openPullsFor(claims, "quill");
  assert.deepEqual(pulls.map(pull => pull.number), [1, 5, 9]);
  assert.equal(pulls[0].url, pr(1));
  assert.equal(openPullsFor(claims, "grok").length, 1);
  assert.deepEqual(openPullsFor(claims, ""), []);
});

test("five open pulls is not over; a sixth steers and names coordinators", () => {
  const five = [1, 2, 3, 4, 5].map(n => held(`c${n}`, "quill", n));
  const atCap = openPrThroughput(five, "quill", authority);
  assert.equal(atCap.cap, DEFAULT_OPEN_PR_CAP);
  assert.equal(atCap.open, 5);
  assert.equal(atCap.over, false);
  assert.equal(atCap.blocking, false);
  assert.equal(atCap.steer, null);
  assert.equal(atCap.coordinatorTold, false);
  assert.deepEqual(atCap.coordinatorMemberIds, []);

  const six = [...five, held("c6", "quill", 6)];
  const over = openPrThroughput(six, "quill", authority);
  assert.equal(over.open, 6);
  assert.equal(over.over, true);
  assert.equal(over.blocking, false);
  assert.match(over.steer, /Finish, rebase, or land your own open pull requests/);
  assert.match(over.steer, /You can keep working/);
  assert.match(over.steer, /room coordinator has been told and can reassign work/);
  assert.deepEqual(over.coordinatorMemberIds, ["owner", "sage"]);
  assert.deepEqual(coordinatorsFor(authority, "quill"), ["owner", "sage"]);
  const inherited = Object.create({ toString: { active: true, permissions: ["manage_claims"] } });
  assert.deepEqual(coordinatorsFor({ ownerId: "quill", members: inherited }, "quill"), []);

  const alone = openPrThroughput(six, "quill", { ownerId: "quill", members: {} });
  assert.equal(alone.coordinatorTold, false);
  assert.doesNotMatch(alone.steer, /room coordinator has been told/);
});

test("the response lists at most 20 pulls and says when the rest were cut", () => {
  const claims = Array.from({ length: 21 }, (_, index) => held(`c${index}`, "quill", index + 1));
  const signal = openPrThroughput(claims, "quill");
  assert.equal(signal.open, 21);
  assert.equal(signal.over, true);
  assert.equal(signal.pulls.length, 20);
  assert.deepEqual(signal.pulls.map(pull => pull.number), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(signal.pullsTruncated, true);
});

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function storeFor(pings, { throwOnWake = false } = {}) {
  return {
    now: () => T0,
    roomAuthority: () => ({
      ownerId: "owner",
      members: {
        owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
        quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
        sage: { id: "sage", kind: "agent", active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
        old: { id: "old", kind: "agent", active: false, permissions: ["manage_claims"] },
        grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      },
    }),
    db: {
      prepare(sql) {
        return {
          get(_roomId, memberId) {
            return String(sql).includes("identity_links") ? { identityId: `idn-${memberId}` } : undefined;
          },
          run() {},
        };
      },
    },
    agentHeartbeats: {
      enqueueWake(wake) {
        if (throwOnWake) throw new Error("queue down");
        return { enqueued: true, signal: { messageId: wake.messageId } };
      },
    },
    agentPlugin: {
      deliverWakePing(ping) { pings.push(ping); },
    },
  };
}

const call = (registry, store, member, route, id, body) => handleWorkClaims({
  req: { method: "POST", body }, res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store, roomId: "room1",
  auth: { member: { id: member, kind: member === "owner" ? "human" : "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

function seed(registry, count, owner = "quill") {
  for (let n = 1; n <= count; n += 1) registry.set("room1", held(`held-${n}`, owner, n));
}

function throughputPings(pings) {
  return pings.filter(ping => ping.signal?.reason === "open_pr_throughput");
}

test("a claim at six open pulls returns 200, steers, and wakes coordinators", async () => {
  const pings = [];
  const registry = createWorkClaimRegistry();
  const store = storeFor(pings);
  seed(registry, 6);
  await call(registry, store, "owner", "create", null, { id: "fresh", title: "Fresh" });
  const { status, value } = await call(registry, store, "quill", "claim", "fresh", {});
  assert.equal(status, 200);
  assert.equal(value.state, "claimed");
  assert.equal(value.openPrThroughput.over, true);
  assert.equal(value.openPrThroughput.blocking, false);
  assert.equal(value.openPrThroughput.open, 6);
  assert.deepEqual([...value.openPrThroughput.coordinatorMemberIds], ["owner", "sage"]);
  assert.match(value.openPrThroughput.steer, /Finish, rebase, or land/);
  assert.equal(registry.get("room1", "fresh").openPrThroughput, undefined, "the signal stays on the response");
  assert.deepEqual(throughputPings(pings).map(ping => ping.identityId).sort(), ["idn-owner", "idn-sage"]);
  assert.ok(throughputPings(pings).every(ping => ping.signal.messageId === "work-claim:throughput:quill"));
});

test("five open pulls do not wake anyone, and a dead wake queue still claims", async () => {
  const quiet = [];
  const quietRegistry = createWorkClaimRegistry();
  seed(quietRegistry, 5);
  const quietStore = storeFor(quiet);
  await call(quietRegistry, quietStore, "owner", "create", null, { id: "fifth", title: "Fifth" });
  const atCap = await call(quietRegistry, quietStore, "quill", "claim", "fifth", {});
  assert.equal(atCap.status, 200);
  assert.equal(atCap.value.openPrThroughput.over, false);
  assert.equal(atCap.value.openPrThroughput.steer, null);
  assert.deepEqual(throughputPings(quiet), []);

  const pings = [];
  const registry = createWorkClaimRegistry();
  seed(registry, 6);
  const store = storeFor(pings, { throwOnWake: true });
  await call(registry, store, "owner", "create", null, { id: "anyway", title: "Anyway" });
  const claimed = await call(registry, store, "quill", "claim", "anyway", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
  assert.equal(claimed.value.openPrThroughput.over, true);
  assert.equal(claimed.value.openPrThroughput.blocking, false);
});

test("assigning to someone over the cap returns 201 and tells coordinators about that assignee", async () => {
  const pings = [];
  const registry = createWorkClaimRegistry();
  const store = storeFor(pings);
  seed(registry, 6);
  const { status, value } = await call(registry, store, "owner", "create", null, {
    id: "assigned", title: "More work", assignee: "quill",
  });
  assert.equal(status, 201);
  assert.equal(value.owner, "quill");
  assert.equal(value.openPrThroughput.open, 6);
  assert.equal(value.openPrThroughput.over, true);
  assert.equal(value.openPrThroughput.blocking, false);
  assert.deepEqual([...value.openPrThroughput.coordinatorMemberIds], ["owner", "sage"]);
  assert.deepEqual(throughputPings(pings).map(ping => ping.identityId).sort(), ["idn-owner", "idn-sage"]);
});

test("linking a sixth pull succeeds, and linking that same pull again does not wake coordinators twice", async t => {
  const { store, owner, ada, memberOf, hold } = room(t);
  const adaId = memberOf(ada);
  const ownerId = memberOf(owner);
  for (let n = 1; n <= 5; n += 1) hold(`held-${n}`, adaId, n);
  const wakes = [];
  const enqueue = store.agentHeartbeats.enqueueWake.bind(store.agentHeartbeats);
  store.agentHeartbeats.enqueueWake = wake => {
    wakes.push(wake);
    return enqueue(wake);
  };
  const board = (memberId, route, id, body) => handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL(`https://room.example/api/rooms/board/work-claims${id ? `/${id}/${route}` : ""}`),
    store, roomId: "board",
    auth: { member: { id: memberId, kind: "agent", permissions: WRITER } },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  await board(ownerId, "create", null, { id: "linked", title: "Linked" });
  const claimed = await board(adaId, "claim", "linked", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.openPrThroughput.over, false);
  const first = await board(adaId, "update", "linked", {
    appendPullRequest: pr(60),
    expectedClaimedAt: claimed.value.claimedAt,
    expectedHistoryLength: claimed.value.history.length,
  });
  assert.equal(first.status, 200);
  assert.equal(first.value.openPrThroughput.open, 6);
  assert.equal(first.value.openPrThroughput.over, true);
  assert.equal(first.value.openPrThroughput.blocking, false);
  assert.match(first.value.openPrThroughput.steer, /Finish, rebase, or land/);
  assert.equal(store.workClaims.get("board", "linked").openPrThroughput, undefined);
  const throughput = () => wakes.filter(wake => wake.messageId === `work-claim:throughput:${adaId}`);
  assert.equal(throughput().length, 1);
  assert.equal(throughput()[0].roomId, "board");
  const second = await board(adaId, "update", "linked", {
    appendPullRequest: pr(60),
    expectedClaimedAt: first.value.claimedAt,
    expectedHistoryLength: first.value.history.length,
  });
  assert.equal(second.status, 200);
  assert.equal(second.value.openPrThroughput.over, true);
  assert.equal(throughput().length, 1);
});

const WRITER = ["steer", "accept_work", "complete_work", "verify"];

function room(t) {
  const store = new RoomStore(":memory:", { now: () => T0 });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen");
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "Throughput", kind: "personal" });
  for (const identity of [ada, bob]) {
    store.identities.link(owner.secret, "board", {
      identityId: identity.identityId,
      displayName: identity === ada ? "Ada" : "Bob",
      permissions: WRITER,
    });
  }
  const memberOf = identity => store.db.prepare(
    "SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?"
  ).get(identity.identityId, "board").m;
  const hold = (id, memberId, number, outcome) => {
    store.workClaims.set("board", held(id, memberId, number, outcome));
  };
  return { store, owner, ada, bob, memberOf, hold };
}

test("needs-me names open pulls only past the cap, and the section leaves the cursor", t => {
  const { store, ada, memberOf, hold } = room(t);
  const adaId = memberOf(ada);
  for (let n = 1; n <= 5; n += 1) hold(`c${n}`, adaId, n);
  const quiet = collectNeedsMe(store, ada.secret, {});
  assert.equal(quiet.openPrThroughput, undefined);
  assert.equal(quiet.coordinatorThroughput, undefined);
  hold("c6", adaId, 6);
  const page = collectNeedsMe(store, ada.secret, { since: quiet.cursor });
  assert.deepEqual(page.cursor, quiet.cursor);
  assert.equal(page.openPrThroughput.length, 1);
  const section = page.openPrThroughput[0];
  assert.equal(section.roomId, "board");
  assert.equal(section.open, 6);
  assert.equal(section.cap, 5);
  assert.equal(section.blocking, false);
  assert.match(section.steer, /Finish, rebase, or land/);
  assert.match(section.steer, /You can keep working/);
  assert.match(section.next, /You can still claim work/);
});

test("merged and closed pulls do not raise a needs-me throughput section", t => {
  const { store, ada, memberOf, hold } = room(t);
  const adaId = memberOf(ada);
  for (let n = 1; n <= 6; n += 1) hold(`c${n}`, adaId, n, n % 2 === 0 ? "merged" : "closed");
  assert.equal(collectNeedsMe(store, ada.secret, {}).openPrThroughput, undefined);
});

test("a room owner is told who is over the cap; a member who cannot reassign is not", t => {
  const { store, owner, ada, bob, memberOf, hold } = room(t);
  const adaId = memberOf(ada);
  const bobId = memberOf(bob);
  for (let n = 1; n <= 6; n += 1) hold(`ada-${n}`, adaId, n);
  hold("bob-1", bobId, 100);
  const ownerPage = collectNeedsMe(store, owner.secret, {});
  assert.equal(ownerPage.openPrThroughput, undefined);
  assert.equal(ownerPage.coordinatorThroughput.length, 1);
  const section = ownerPage.coordinatorThroughput[0];
  assert.equal(section.roomId, "board");
  assert.deepEqual(section.members.map(member => member.memberId), [adaId]);
  assert.equal(section.members[0].open, 6);
  assert.match(section.next, /Reassign work/);
  const bobPage = collectNeedsMe(store, bob.secret, {});
  assert.equal(bobPage.coordinatorThroughput, undefined);
  assert.equal(bobPage.openPrThroughput, undefined);
});
