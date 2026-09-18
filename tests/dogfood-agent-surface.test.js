// Dogfood Iteration 2 — agent-surface fixes (RC-2026-09-18-012).
//
// 1. `rak_` API keys authenticate over HTTP as the agent identity (scoped:
//    reads need rooms:read, writes need rooms:write, agent plugs need their
//    own scope) and never reach key management or the human inbox.
// 2. Room members can list/read visibility:"room" directory cards.
// 3. Targeted DMs (toMemberId) stay private to sender + addressed member.
// 4. New room-scoped agent inbox at /api/rooms/{roomId}/agent-inbox.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function startServer(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store: f.store, keys: f.keys };
}

const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const errCode = async res => {
  try { return (await res.json()).error?.code ?? `http-${res.status}`; }
  catch { return `http-${res.status}`; }
};
// Read a response body exactly once: asserts the status and returns the
// parsed JSON (or null). Use this whenever the body is needed afterwards —
// an `assert(..., await errCode(res))` message arg consumes the body eagerly.
const must = async (res, expected, what) => {
  const text = await res.text();
  let parsed = null, code = `http-${res.status}`;
  try { parsed = JSON.parse(text); code = parsed.error?.code ?? code; } catch {}
  assert.equal(res.status, expected, `${what}: ${code}`);
  return parsed;
};

// Link an agent identity into the commons room as a room member.
function linkAgent(store, ownerKey, name, memberId) {
  const identity = store.identities.create(name);
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId, displayName: name, permissions: ["accept_work"],
  });
  return { ...identity, memberId: linked.memberId };
}

async function issueKey(origin, priSecret, scopes) {
  const body = await must(await post(origin, "/api/agent-keys", { scopes, label: "dogfood test key" }, priSecret), 201, "key issue");
  return { presented: `rak_${body.secret}`, keyId: body.keyId };
}

const cardFields = name => ({
  name, description: `Synthetic dogfood card for ${name}; no real people.`,
  url: "https://agent.example.test", capabilities: ["chat"], version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Fix 1: rak_ API keys authenticate as the agent identity over HTTP.
// ---------------------------------------------------------------------------

test("api key: issue, read and write as the linked agent identity", async t => {
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood key agent", "keyagent");
  const key = await issueKey(origin, agent.secret, ["rooms:read", "rooms:write"]);
  assert.match(key.presented, /^rak_/);

  const events = await get(origin, "/api/rooms/commons/events?after=0&limit=5", key.presented);
  assert.equal(events.status, 200, `events with key: ${await errCode(events)}`);

  const sent = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "key-msg-1", body: "posted with an API key" },
  }, key.presented);
  assert.equal(sent.status, 201, `post with key: ${await errCode(sent)}`);

  const seen = await get(origin, "/api/rooms/commons/events?after=0&limit=100", key.presented);
  const posted = (await seen.json()).events.map(r => r.event)
    .filter(e => e.type === T.MESSAGE_POSTED && e.data?.messageId === "key-msg-1");
  assert.equal(posted.length, 1, "key-authenticated write is attributed to the linked agent member");
  assert.equal(posted[0].actorId, "keyagent");
});

test("api key: wrong scope is denied with 403 insufficient_scope", async t => {
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood scoped agent", "scopedagent");
  const reader = await issueKey(origin, agent.secret, ["rooms:read"]);
  const publisher = await issueKey(origin, agent.secret, ["directory:publish"]);

  const write = await must(await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "scoped-msg-1", body: "should not post" },
  }, reader.presented), 403, "write without rooms:write");
  assert.equal(write.error?.code, "insufficient_scope");

  const cardPost = await must(await post(origin, "/api/agent-directory/cards",
    { agentId: "scoped-dogfood", card: cardFields("Scoped Dogfood"), visibility: "public" }, reader.presented),
    403, "publish without directory:publish");
  assert.equal(cardPost.error?.code, "insufficient_scope");

  const events = await must(await get(origin, "/api/rooms/commons/events?after=0&limit=5", publisher.presented),
    403, "read without rooms:read");
  assert.equal(events.error?.code, "insufficient_scope");
});

test("api key: revoked key is 401; keys can never manage keys", async t => {
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood revoked agent", "revokedagent");
  const key = await issueKey(origin, agent.secret, ["rooms:read"]);

  const before = await get(origin, "/api/rooms/commons/events?after=0&limit=5", key.presented);
  assert.equal(before.status, 200);

  // A valid key still cannot manage keys: key administration stays
  // owner-secret-only.
  const issue = await must(await post(origin, "/api/agent-keys", { scopes: ["rooms:read"] }, key.presented),
    403, "key issuing a key");
  assert.equal(issue.error?.code, "insufficient_scope");

  await must(await post(origin, `/api/agent-keys/${key.keyId}/revoke`, {}, agent.secret),
    200, "revoke");
  const after = await must(await get(origin, "/api/rooms/commons/events?after=0&limit=5", key.presented),
    401, "revoked key");
  assert.equal(after.error?.code, "unauthenticated");
});

test("api key: human inbox stays account-session isolated from Bearer <redacted>", async t => {
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood isolation agent", "isolatedagent");
  const key = await issueKey(origin, agent.secret, ["rooms:read", "inbox:read"]);

  const withKey = await must(await get(origin, "/api/inbox/threads", key.presented),
    401, "human inbox with rak_");
  assert.equal(withKey.error?.code, "account_session_required");

  const withPri = await must(await get(origin, "/api/inbox/threads", agent.secret),
    401, "human inbox with pri_");
  assert.equal(withPri.error?.code, "account_session_required");
});

// ---------------------------------------------------------------------------
// Fix 2: room members can list/read visibility:"room" directory cards.
// ---------------------------------------------------------------------------

async function publishCards(t) {
  const { origin, store, keys } = await startServer(t);
  const member = linkAgent(store, keys.owner, "dogfood dir member", "dirmember");
  // An agent identity that was never linked to the room: authenticates on the
  // directory surface (public view) but holds no room membership.
  const stranger = store.identities.create("dogfood dir stranger");
  const pub = async (agentId, visibility) => {
    const res = await post(origin, "/api/agent-directory/cards",
      { agentId, card: cardFields(`Dogfood ${agentId}`), visibility }, member.secret);
    assert.equal(res.status, 201, `publish ${visibility}: ${await errCode(res)}`);
    return agentId;
  };
  return {
    origin, store, keys, member, stranger,
    publicId: await pub("dogfood-public", "public"),
    roomId: await pub("dogfood-room", "room"),
    privateId: await pub("dogfood-private", "private"),
  };
}

test("directory: anonymous callers see only public cards", async t => {
  const { origin, publicId, roomId } = await publishCards(t);
  const list = await get(origin, "/api/agent-directory");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).agents.map(a => a.agentId).sort(), [publicId]);
  assert.equal((await get(origin, `/api/agents/directory/${roomId}`)).status, 404);
  assert.equal((await get(origin, `/api/agents/directory/${publicId}`)).status, 200);
});

test("directory: room members see room cards but not private ones", async t => {
  const { origin, member, publicId, roomId, privateId } = await publishCards(t);
  const list = await get(origin, "/api/agent-directory", member.secret);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).agents.map(a => a.agentId).sort(), [publicId, roomId].sort());
  assert.equal((await get(origin, `/api/agents/directory/${roomId}`, member.secret)).status, 200);
  assert.equal((await get(origin, `/api/agents/directory/${privateId}`, member.secret)).status, 404);
});

test("directory: non-member identity sees public cards only", async t => {
  const { origin, stranger, publicId, roomId } = await publishCards(t);
  const list = await get(origin, "/api/agent-directory", stranger.secret);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).agents.map(a => a.agentId).sort(), [publicId]);
  assert.equal((await get(origin, `/api/agents/directory/${roomId}`, stranger.secret)).status, 404);
});

test("directory: scoped key needs directory:read for the member view", async t => {
  const { origin, member, publicId, roomId } = await publishCards(t);
  const withRead = await issueKey(origin, member.secret, ["rooms:read", "directory:read"]);
  const list = await get(origin, "/api/agent-directory", withRead.presented);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).agents.map(a => a.agentId).sort(), [publicId, roomId].sort());

  const withoutRead = await issueKey(origin, member.secret, ["rooms:read"]);
  const pub = await get(origin, "/api/agent-directory", withoutRead.presented);
  assert.deepEqual((await pub.json()).agents.map(a => a.agentId), [publicId]);
  assert.equal((await get(origin, `/api/agents/directory/${roomId}`, withoutRead.presented)).status, 404);
  assert.equal(await errCode(await get(origin, `/api/agents/directory/${roomId}`, withoutRead.presented)), "unknown_card");
});

// ---------------------------------------------------------------------------
// Fix 3: targeted DMs are private to sender + addressed member.
// ---------------------------------------------------------------------------

async function dmSetup(t) {
  const { origin, store, keys } = await startServer(t);
  const jill = linkAgent(store, keys.owner, "dogfood dm jill", "dmjill");
  const grok = linkAgent(store, keys.owner, "dogfood dm grok", "dmgrok");
  const codex = linkAgent(store, keys.owner, "dogfood dm codex", "dmcodex");
  const dm = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "dm-secret-1", body: "eyes only: the launch code is 481516", toMemberId: grok.memberId },
  }, jill.secret);
  assert.equal(dm.status, 201, `dm post: ${await errCode(dm)}`);
  const open = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "dm-open-1", body: "room-wide hello" },
  }, jill.secret);
  assert.equal(open.status, 201, `open post: ${await errCode(open)}`);
  return { origin, jill, grok, codex };
}

const eventsOf = async (origin, secret) =>
  (await (await get(origin, "/api/rooms/commons/events?after=0&limit=100", secret)).json()).events.map(r => r.event);

test("dm: uninvolved member cannot read a targeted DM through events", async t => {
  const { origin, codex } = await dmSetup(t);
  const events = await eventsOf(origin, codex.secret);
  const payload = JSON.stringify(events);
  assert.ok(!payload.includes("481516"), "DM body leaks to an uninvolved member");
  assert.ok(!events.some(e => e.data?.messageId === "dm-secret-1"), "DM record visible to an uninvolved member");
  assert.ok(events.some(e => e.data?.messageId === "dm-open-1"), "normal room message still visible");
});

test("dm: sender and addressed member read the DM", async t => {
  const { origin, jill, grok } = await dmSetup(t);
  for (const [who, identity] of [["recipient", grok], ["sender", jill]]) {
    const events = await eventsOf(origin, identity.secret);
    const dm = events.find(e => e.data?.messageId === "dm-secret-1");
    assert.ok(dm, `${who} sees the DM`);
    assert.equal(dm.data.body, "eyes only: the launch code is 481516");
  }
});

test("dm: cursor still advances past filtered DMs", async t => {
  const { origin, codex } = await dmSetup(t);
  const page = await (await get(origin, "/api/rooms/commons/events?after=0&limit=100", codex.secret)).json();
  assert.ok(typeof page.next === "number" && page.next > 0, "cursor advances");
  const tail = await get(origin, `/api/rooms/commons/events?after=${page.next}&limit=100`, codex.secret);
  assert.equal(tail.status, 200, `tail fetch: ${await errCode(tail)}`);
});

// ---------------------------------------------------------------------------
// Fix 4: room-scoped agent inbox at /api/rooms/{roomId}/agent-inbox.
// ---------------------------------------------------------------------------

async function inboxSetup(t) {
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood inbox agent", "inboxagent");
  const other = linkAgent(store, keys.owner, "dogfood inbox other", "inboxother");
  const dm = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "inbox-dm-1", body: "your assignment is ready", toMemberId: agent.memberId },
  }, keys.owner);
  assert.equal(dm.status, 201, `inbox dm: ${await errCode(dm)}`);
  const assigned = await post(origin, "/api/rooms/commons/collab/assignments", {
    threadId: "sms:fixture-conn:thread-1", assignee: { kind: "agent", id: agent.memberId },
  }, keys.owner);
  assert.equal(assigned.status, 201, `assign: ${await errCode(assigned)}`);
  const mentioned = await post(origin, "/api/rooms/commons/collab/routing/mentions", {
    mentionedAgentId: agent.memberId, threadId: "email:fixture-conn:thread-2", context: "needs an agent reply",
  }, keys.owner);
  assert.equal(mentioned.status, 201, `mention: ${await errCode(mentioned)}`);
  return { origin, store, keys, agent, other };
}

test("agent inbox: own DMs, assignments and mentions across channels", async t => {
  const { origin, agent, other } = await inboxSetup(t);
  const inbox = await must(await get(origin, "/api/rooms/commons/agent-inbox", agent.secret), 200, "inbox");
  assert.equal(inbox.agentId, "inboxagent");
  assert.ok(inbox.directMessages.some(m => m.body === "your assignment is ready" && m.channel === "room"),
    "targeted DM in inbox");
  assert.ok(inbox.assignments.some(a => a.threadId === "sms:fixture-conn:thread-1" && a.channel === "sms"),
    "SMS fixture thread in inbox");
  assert.ok(inbox.mentions.some(m => m.threadId === "email:fixture-conn:thread-2" && m.channel === "email"),
    "email fixture mention in inbox");

  const otherInbox = await must(await get(origin, "/api/rooms/commons/agent-inbox", other.secret), 200, "other inbox");
  assert.equal(otherInbox.directMessages.length, 0, "another agent sees no foreign DM");
  assert.equal(otherInbox.assignments.length, 0, "another agent sees no foreign assignment");
  assert.equal(otherInbox.mentions.length, 0, "another agent sees no foreign mention");
});

test("agent inbox: scoped key needs inbox:read; humans are refused", async t => {
  const { origin, keys, agent } = await inboxSetup(t);
  const scoped = await issueKey(origin, agent.secret, ["inbox:read"]);
  assert.equal((await get(origin, "/api/rooms/commons/agent-inbox", scoped.presented)).status, 200);

  // Least privilege: the inbox key implies no rooms:read — the room event
  // log stays closed to it.
  const events = await must(await get(origin, "/api/rooms/commons/events?after=0&limit=5", scoped.presented),
    403, "inbox key reading events");
  assert.equal(events.error?.code, "insufficient_scope");

  const plain = await issueKey(origin, agent.secret, ["rooms:read"]);
  const denied = await must(await get(origin, "/api/rooms/commons/agent-inbox", plain.presented),
    403, "inbox without inbox:read");
  assert.equal(denied.error?.code, "insufficient_scope");

  const human = await must(await get(origin, "/api/rooms/commons/agent-inbox", keys.owner),
    403, "human member");
  assert.equal(human.error?.code, "agent_inbox_agent_only");
});

test("agent inbox: cold room with no prior collab writes returns 200", async t => {
  // RC-2026-09-18-013: the first per-room collab access lazily replays the
  // journal in a WRITE transaction; agentInbox must not 500 when that replay
  // has never run (no collab writes yet in this room/process).
  const { origin, store, keys } = await startServer(t);
  const agent = linkAgent(store, keys.owner, "dogfood inbox cold", "inboxcold");
  const inbox = await must(await get(origin, "/api/rooms/commons/agent-inbox", agent.secret),
    200, "cold-room inbox");
  assert.equal(inbox.agentId, "inboxcold");
  assert.deepEqual(inbox.directMessages, []);
  assert.deepEqual(inbox.assignments, []);
  assert.deepEqual(inbox.mentions, []);
});
