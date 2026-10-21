// SCALE-HANDOFF (2026-10-20): specimens for UT-BIGROOM F-2/F-3 and
// UT-MULTIAGENT F-1/F-2. Each test fails on the pre-fix code for the
// intended reason and passes after:
//  F-2 (BIGROOM) a claim-mutation burst trips the product's 429
//      rate_limited; the refusal body must name its scope + retry terms
//      (this is the product's limiter, not GitHub's 429).
//  F-3 (BIGROOM) the activation pack's openClaims slices at 50 silently;
//      the pack must carry openClaimsTotal + openClaimsTruncated.
//  F-1 (MULTIAGENT) listMentions keys a mention by messageEventId only;
//      it must also carry messageId (the id needs-me/wake key by).
//  F-2 (MULTIAGENT) a released claim must project the progress-message
//      pointer its holder set (noteMessageId in, progressMessageId out).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildActivationPack } from "../server/room-activation-pack.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function memStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "scale-handoff-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

async function serve(t, store) {
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// --- F-3: pack truncation marker at the BIGROOM scale shape ----------------
test("F-3: pack with 60 unclaimed claims slices at 50 and says so", t => {
  const store = memStore(t);
  for (let i = 1; i <= 60; i++) {
    store.workClaims.set("commons", { id: `scale-claim-${String(i).padStart(2, "0")}`, title: `Scale ${i}`, state: "unclaimed", owner: null, history: [] });
  }
  const pack = buildActivationPack(store, "commons", "owner");
  assert.equal(pack.openClaims.length, 50, "the slice itself is unchanged");
  assert.equal(pack.openClaimsTotal, 60, "the pack names the full claimable total");
  assert.equal(pack.openClaimsTruncated, true, "the pack flags the slice as truncated");
});

test("F-3: pack under the cap reports truncated=false with the true total", t => {
  const store = memStore(t);
  store.workClaims.set("commons", { id: "only-claim", title: "Only", state: "unclaimed", owner: null, history: [] });
  const pack = buildActivationPack(store, "commons", "owner");
  assert.equal(pack.openClaims.length, 1);
  assert.equal(pack.openClaimsTotal, 1);
  assert.equal(pack.openClaimsTruncated, false);
});

// --- F-1: mentions join on messageId ---------------------------------------
test("F-1: listMentions and mentionView carry messageId beside messageEventId", t => {
  const store = memStore(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] } });
  const aliceKey = store.issueAccessKey("commons", "alice");
  const posted = store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "scale-mention-msg", body: "@Alice please look" } });
  const eventId = posted.event.id;
  assert.notEqual(eventId, "scale-mention-msg", "the specimen needs two distinct ids");
  const listed = store.listMentions(aliceKey, "commons", {}, null);
  assert.equal(listed.mentions.length, 1);
  assert.equal(listed.mentions[0].messageEventId, eventId);
  assert.equal(listed.mentions[0].messageId, "scale-mention-msg", "mentions list joins needs-me/wake on messageId");
  const view = store.mentionView("commons", eventId, "alice");
  assert.equal(view.messageId, "scale-mention-msg");
  assert.equal(view.messageEventId, eventId);
});

// --- F-2 claim pointer: route harness --------------------------------------
const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  return { calls, reject, json: (res, status, value) => { calls.push({ status, value }); return { status, value }; }, body: async req => req.body };
};
const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, storeMessages = [] }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({ ownerId: "quill", members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
      grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }),
    room: () => ({ sequence: 1, state: { messages: storeMessages } }),
  };
  try {
    const out = await handleWorkClaims({ req: { method: "POST", body }, res: {}, url: {}, store, roomId: "room1",
      auth: { member: { id: memberId, kind: "agent", permissions: [] } }, workClaimRoute: route, workClaimId: id, helpers, registry });
    return { out, error: null };
  } catch (error) { return { out: null, error }; }
};
const progressMsg = (authorId = "quill") => ({ id: "progress-1", authorId, body: "spec lines 2-3 here", createdAt: new Date().toISOString(), revision: 0 });

test("F-2: release with noteMessageId projects progressMessageId on the released claim", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry })).error, null);
  assert.equal((await runRoute({ route: "claim", id: "w1", body: {}, registry })).error, null);
  const item = registry.get("room1", "w1");
  const released = await runRoute({ route: "release", id: "w1", registry, storeMessages: [progressMsg()],
    body: { expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length, noteMessageId: "progress-1" } });
  assert.equal(released.error, null, released.error?.message);
  assert.equal(released.out.value.state, "unclaimed");
  assert.equal(released.out.value.progressMessageId, "progress-1", "the next holder can find the progress message from the claim alone");
  assert.equal(registry.get("room1", "w1").progressMessageId, "progress-1", "the pointer survives on the stored claim");
});

test("F-2: update with progressMessageId sets the pointer and release without one keeps it", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry });
  await runRoute({ route: "claim", id: "w1", body: {}, registry });
  const updated = await runRoute({ route: "update", id: "w1", registry, storeMessages: [progressMsg()], body: { note: "working", progressMessageId: "progress-1" } });
  assert.equal(updated.error, null, updated.error?.message);
  assert.equal(updated.out.value.progressMessageId, "progress-1");
  const item = registry.get("room1", "w1");
  const released = await runRoute({ route: "release", id: "w1", registry, body: { expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length } });
  assert.equal(released.error, null);
  assert.equal(released.out.value.progressMessageId, "progress-1", "a plain release does not drop the pointer");
});

test("F-2: a pointer naming another member's message or no message is refused", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry });
  await runRoute({ route: "claim", id: "w1", body: {}, registry });
  const foreign = await runRoute({ route: "update", id: "w1", registry, storeMessages: [progressMsg("grok")], body: { note: "x", progressMessageId: "progress-1" } });
  assert.ok(foreign.error, "another member's message must not validate");
  const missing = await runRoute({ route: "update", id: "w1", registry, storeMessages: [], body: { note: "x", progressMessageId: "nope" } });
  assert.ok(missing.error, "a missing message must not validate");
  assert.equal(registry.get("room1", "w1").progressMessageId ?? null, null, "refused pointers are never stored");
});

// --- F-2 (BIGROOM): the burst, at scale shape, over HTTP -------------------
test("F-2: a claim-mutation burst trips a 429 whose body names scope + retry terms", async t => {
  const store = memStore(t);
  const origin = await serve(t, store);
  const ownerKey = store.issueAccessKey("commons", "owner");
  let limited = null;
  let created = 0;
  for (let i = 1; i <= 200 && !limited; i++) {
    const res = await fetch(`${origin}/api/rooms/commons/work-claims`, {
      method: "POST", headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: `burst-claim-${i}`, title: `Burst ${i}` }),
    });
    if (res.status === 429) { limited = { res, body: await res.json() }; break; }
    assert.equal(res.status, 201, `create ${i} before the limit`);
    created++;
  }
  assert.ok(limited, "the burst must trip the limiter");
  assert.ok(created >= 50, `the burst ran at scale before tripping (created ${created})`);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal(limited.body.rateLimit.scope, "write", "the body names the limiting scope");
  assert.equal(limited.body.rateLimit.limit, 60, "the body names the limit");
  assert.ok(Number.isInteger(limited.body.rateLimit.retryAfterSeconds) && limited.body.rateLimit.retryAfterSeconds >= 1 && limited.body.rateLimit.retryAfterSeconds <= 60,
    "the body names the retry interval in seconds");
  assert.ok(typeof limited.body.rateLimit.resetAt === "string" && !Number.isNaN(Date.parse(limited.body.rateLimit.resetAt)), "the body names when the window resets");
  assert.equal(limited.res.headers.get("x-ratelimit-bucket"), "write");
  assert.ok(Number(limited.res.headers.get("retry-after")) >= 1, "Retry-After header present");
});
