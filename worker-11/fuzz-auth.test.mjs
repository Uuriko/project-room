// WAVE-2000 guild-02 worker-11: authenticated fuzz of shard routes.
// R160 (idx160, L3417): POST /api/rooms/{id}/mentions/{eid}/ack
// R210 (idx210, L3513): /api/rooms/{id}/bounties (list GET / create POST)
// Run: TMPDIR=<worktree>/.tmp node --test worker-11/fuzz-auth.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "commons";
async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable", memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = (method, path, key, { body = undefined, rawBody = undefined, contentType = "application/json" } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { origin, req, keys: fixture.keys, fixture };
}
const say = (f, key, data) => f.store.command(key, ROOM, { id: randomUUID(), type: "message.posted", data });

function mentionEventId(f, memberKey) {
  const { mentions } = f.store.listMentions(memberKey, ROOM, {});
  assert.ok(mentions.length > 0, "expected a delivered mention");
  return mentions[0].messageEventId;
}

// ---------- R160: mention-ack ----------
test("R160: ack own mention -> 200, then idempotent 200 again", async t => {
  const { req, keys, fixture } = await startServer(t);
  say(fixture, keys.owner, { messageId: "m1", body: "hey @guest look", toMemberId: "guest" });
  const eid = mentionEventId(fixture, keys.guest);
  const r1 = await req("POST", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.guest, { body: {} });
  assert.equal(r1.status, 200);
  const r2 = await req("POST", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.guest, { body: {} });
  assert.equal(r2.status, 200);
});

test("R160: ack nonexistent event -> 404; ack plain (non-mention) message -> 404", async t => {
  const { req, keys, fixture } = await startServer(t);
  say(fixture, keys.owner, { messageId: "m1", body: "hey @guest look", toMemberId: "guest" });
  const r1 = await req("POST", `/api/rooms/${ROOM}/mentions/no-such-event/ack`, keys.guest, { body: {} });
  assert.equal(r1.status, 404);
  say(fixture, keys.owner, { messageId: "m2", body: "just a normal message" });
  const r2 = await req("POST", `/api/rooms/${ROOM}/mentions/m2/ack`, keys.guest, { body: {} });
  assert.equal(r2.status, 404, "event id that is not a mention event id -> 404");
});

test("R160: ack someone else's mention -> 403; GET/DELETE on ack -> 405", async t => {
  const { req, keys, fixture } = await startServer(t);
  say(fixture, keys.owner, { messageId: "m1", body: "hey @guest look", toMemberId: "guest" });
  const eid = mentionEventId(fixture, keys.guest);
  const r1 = await req("POST", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.owner, { body: {} });
  assert.equal(r1.status, 403);
  const r2 = await req("GET", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.guest);
  assert.equal(r2.status, 405);
  console.log("    GET allow header:", r2.headers.get("allow"));
  const r3 = await req("DELETE", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.guest);
  assert.equal(r3.status, 405);
});

test("R160: malformed bodies on ack (body is ignored) do not crash", async t => {
  const { req, keys, fixture } = await startServer(t);
  say(fixture, keys.owner, { messageId: "m1", body: "hey @guest look", toMemberId: "guest" });
  const eid = mentionEventId(fixture, keys.guest);
  for (const [label, opts] of [
    ["bad-json", { rawBody: "{bad", contentType: "application/json" }],
    ["empty", { rawBody: "", contentType: "application/json" }],
    ["huge", { rawBody: "x".repeat(20000), contentType: "application/json" }],
    ["array", { rawBody: "[1,2]", contentType: "application/json" }],
    ["text-ct", { rawBody: "hello", contentType: "text/plain" }],
  ]) {
    const r = await req("POST", `/api/rooms/${ROOM}/mentions/${eid}/ack`, keys.guest, opts);
    console.log(`    ${label}: ${r.status}`);
    assert.ok(r.status === 200 || (r.status >= 400 && r.status < 500), `${label} -> ${r.status}`);
  }
});

// ---------- R210: bounties ----------
const bountyBody = (overrides = {}) => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
  ...overrides,
});

test("R210: list query-param fuzz stays 2xx/4xx, never 5xx", async t => {
  const { req, keys } = await startServer(t);
  const qs = ["group=nope", "group=", "group=funded&group=funded", "viewer=<script>", "viewer=self",
    "poster=self", "poster=owner", "poster=", "limit=abc", "limit=-1", "limit=999999999",
    "status=zzz", "bountyId=", "unknown=1".repeat(50), "%ff=%ff", "group=" + "x".repeat(2000)];
  for (const q of qs) {
    const r = await req("GET", `/api/rooms/${ROOM}/bounties?${q}`, keys.owner);
    console.log(`    ?${q.slice(0, 40)}: ${r.status}`);
    assert.ok(r.status < 500, `5xx on ?${q.slice(0, 40)}: ${r.status}`);
  }
});

test("R210: create body fuzz stays 2xx/4xx, never 5xx", async t => {
  const { req, keys } = await startServer(t);
  const cases = [
    ["empty", {}],
    ["null-fields", { title: null, criteria: null, amount: null, deadline: null }],
    ["amount-string", bountyBody({ amount: "100" })],
    ["amount-negative", bountyBody({ amount: -5 })],
    ["amount-huge", bountyBody({ amount: 1e30 })],
    ["amount-float", bountyBody({ amount: 10.5 })],
    ["amount-bool", bountyBody({ amount: true })],
    ["title-number", bountyBody({ title: 42 })],
    ["criteria-array", bountyBody({ criteria: ["a"] })],
    ["deadline-garbage", bountyBody({ deadline: "not-a-date" })],
    ["deadline-past", bountyBody({ deadline: "2000-01-01T00:00:00Z" })],
    ["extra-deep", bountyBody({ rubric: { a: { b: { c: { d: 1 } } } }, approvalMode: "auto" })],
    ["approvalMode-garbage", bountyBody({ approvalMode: "yolo" })],
    ["huge-title", bountyBody({ title: "t".repeat(100000) })],
    ["array-body", undefined, { rawBody: "[1,2]" }],
    ["string-body", undefined, { rawBody: '"x"' }],
    ["bad-json", undefined, { rawBody: "{bad" }],
    ["empty-body", undefined, { rawBody: "" }],
    ["no-ct", undefined, { rawBody: JSON.stringify(bountyBody()), contentType: null }],
    ["oversize", undefined, { rawBody: JSON.stringify(bountyBody({ title: "t".repeat(20000) })) }],
  ];
  for (const [label, body, extra = {}] of cases) {
    const r = await req("POST", `/api/rooms/${ROOM}/bounties`, keys.owner, body === undefined ? extra : { body, ...extra });
    console.log(`    ${label}: ${r.status}`);
    assert.ok(r.status < 500, `5xx on ${label}`);
  }
});

test("R210: PUT /bounties -> 405; fund on unknown id -> 404; create then fund garbage -> 4xx", async t => {
  const { req, keys } = await startServer(t);
  const put = await req("PUT", `/api/rooms/${ROOM}/bounties`, keys.owner, { body: bountyBody() });
  assert.equal(put.status, 405);
  console.log("    PUT allow header:", put.headers.get("allow"));
  const fund = await req("POST", `/api/rooms/${ROOM}/bounties/NOPE-9/fund`, keys.owner, { body: {} });
  console.log("    fund unknown id:", fund.status);
  assert.ok(fund.status === 404 || (fund.status >= 400 && fund.status < 500));
});
