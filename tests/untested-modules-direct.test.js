// F-33 (charter C-10): direct tests for server modules that were previously
// counted as "tested" only because a test file mentioned their
// `server/<path>` — a mention is not a test. Each test below imports its
// module and makes behavioural assertions on an export. Modules that are
// deliberately covered only at the HTTP boundary instead carry a waiver row
// in scripts/untested-modules-lint.mjs (WAIVED), with the covering tests
// named there.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  OPERATOR_TOKEN_ENV, configuredOperatorTokenHash, operatorSurfaceEnabled,
  presentedOperatorToken, operatorTokenMatches, carriesRoomOrAccountCookie
} from "../server/operator-auth.mjs";
import {
  RETURN_BRIEF_DEFAULT_LIMIT, RETURN_BRIEF_MAX_LIMIT, ReturnBriefError,
  resolveHistoryWindow, buildReturnBrief
} from "../server/return-brief.mjs";
import { ThreadMutes, threadMutesSchema } from "../server/thread-mutes.mjs";
import { OwnerDelegates, ownerDelegateSchema } from "../server/owner-delegates.mjs";
import {
  roomKeyHostId, scopedKeyHostId, scopedKeyRoomBinding, roomKeyPresenceView
} from "../server/room-key-presence.mjs";
import { railActor, railFail } from "../server/trial-task-store.mjs";
import {
  OPPORTUNITIES_DEFAULT_LIMIT, OPPORTUNITIES_MAX_LIMIT, buildOpportunitiesFeed
} from "../server/opportunities.mjs";
import { auditWorkHelp } from "../server/work-help.mjs";
import { AGENT_FLEET_ROUTES, agentsOverview } from "../server/routes/agents.mjs";
import {
  CODE_DROP_ROUTES, shareCodeDrop, listCodeDrops, readCodeDrop, rawCodeDrop, checkCodeDrop
} from "../server/routes/code-drops.mjs";
import { DESKTOP_AUTH_ROUTES } from "../server/routes/desktop-auth.mjs";
import { RECORD_RAIL_ROUTES } from "../server/routes/record-rails.mjs";
import { ROOM_ASSISTANT_ROUTES, roomAssistantRoute } from "../server/routes/room-assistant.mjs";

const sha256 = s => createHash("sha256").update(s).digest("hex");

// ---------- operator-auth: pure credential checks, no store ----------
test("operator-auth: configured hash parsing is strict hex sha256", () => {
  const good = "a".repeat(64);
  assert.equal(configuredOperatorTokenHash({}), null);
  assert.equal(configuredOperatorTokenHash({ [OPERATOR_TOKEN_ENV]: "" }), null);
  assert.equal(configuredOperatorTokenHash({ [OPERATOR_TOKEN_ENV]: "not-hex" }), null);
  assert.equal(configuredOperatorTokenHash({ [OPERATOR_TOKEN_ENV]: 42 }), null);
  assert.equal(configuredOperatorTokenHash({ [OPERATOR_TOKEN_ENV]: ` ${good.toUpperCase()} ` }), good);
  assert.equal(operatorSurfaceEnabled({ [OPERATOR_TOKEN_ENV]: good }), true);
  assert.equal(operatorSurfaceEnabled({}), false);
});

test("operator-auth: presented token must be an Operator header of 32+ bytes", () => {
  const token = "t".repeat(40);
  assert.equal(presentedOperatorToken(`Operator ${token}`), token);
  assert.equal(presentedOperatorToken(`Bearer ${token}`), null);
  assert.equal(presentedOperatorToken("Operator short"), null);
  assert.equal(presentedOperatorToken(`Operator ${"x".repeat(300)}`), null);
  assert.equal(presentedOperatorToken(undefined), null);
});

test("operator-auth: token matching compares sha256 digests", () => {
  const token = "s".repeat(48);
  const env = { [OPERATOR_TOKEN_ENV]: sha256(token) };
  assert.equal(operatorTokenMatches(token, env), true);
  assert.equal(operatorTokenMatches("s".repeat(47) + "x", env), false);
  assert.equal(operatorTokenMatches(token, {}), false);
  assert.equal(operatorTokenMatches(null, env), false);
});

test("operator-auth: room/account cookies are not operator credentials", () => {
  assert.equal(carriesRoomOrAccountCookie("room_session=abc"), true);
  assert.equal(carriesRoomOrAccountCookie("cart=1; account_session=xyz"), true);
  assert.equal(carriesRoomOrAccountCookie("cart=1; theme=dark"), false);
  assert.equal(carriesRoomOrAccountCookie(""), false);
  assert.equal(carriesRoomOrAccountCookie(undefined), false);
});

// ---------- return-brief: pure paging-window resolution ----------
test("return-brief: first page freezes the horizon at the current sequence", () => {
  assert.equal(RETURN_BRIEF_DEFAULT_LIMIT, 50);
  assert.equal(RETURN_BRIEF_MAX_LIMIT, 100);
  assert.deepEqual(
    resolveHistoryWindow({ sequence: 120, storedCursor: 40 }),
    { H: 120, startAfter: 40, C: 40, limit: 50 });
});

test("return-brief: invalid windows fail with the documented codes", () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ReturnBriefError); return e.code; } throw new Error("expected throw"); };
  assert.equal(code(() => resolveHistoryWindow({ sequence: 1, storedCursor: 0, limit: 0 })), "invalid_cursor");
  assert.equal(code(() => resolveHistoryWindow({ sequence: 1, storedCursor: 0, limit: 101 })), "invalid_cursor");
  assert.equal(code(() => resolveHistoryWindow({ sequence: 10, storedCursor: 0, horizon: 11, after: 0, continuationCursor: 0 })), "cursor_ahead");
  assert.equal(code(() => resolveHistoryWindow({ sequence: 120, storedCursor: 41, horizon: 100, after: 60, continuationCursor: 40 })), "cursor_changed");
  assert.equal(code(() => resolveHistoryWindow({ sequence: 120, storedCursor: 40, horizon: 100, after: 30, continuationCursor: 40 })), "invalid_cursor");
});

test("return-brief: continuation carries the frozen horizon and cursor", () => {
  assert.deepEqual(
    resolveHistoryWindow({ sequence: 120, storedCursor: 40, horizon: 100, after: 60, continuationCursor: 40, limit: 10 }),
    { H: 100, startAfter: 60, C: 40, limit: 10 });
});

test("return-brief: buildReturnBrief assembles history and continuation", () => {
  const brief = buildReturnBrief({
    sequence: 5, workItems: {}, memberId: "mem-1",
    rows: [{ sequence: 3, event: { type: "message.posted" } }],
    H: 5, startAfter: 2, C: 2
  });
  assert.equal(brief.viewerId, "mem-1");
  assert.deepEqual(brief.history, {
    cursor: 2, evaluatedThrough: 5,
    items: [{ sequence: 3, event: { type: "message.posted" } }],
    hasMore: true, continuation: { horizon: 5, after: 3, cursor: 2 }
  });
  assert.equal(brief.current.evaluatedThrough, 5);
  assert.deepEqual(brief.current.needsAttention, []);
  assert.deepEqual(brief.current.workInvolvingMe, []);
});

// ---------- thread-mutes: real SQL behaviour over a stub store ----------
function threadMutesFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(threadMutesSchema);
  const messages = [
    { id: "root-1" },
    { id: "child-1", replyToId: "root-1" },
    { id: "grand-1", replyToId: "child-1" },
    { id: "dm-1", authorId: "other", toMemberId: "someone-else" }
  ];
  const store = {
    db,
    room: () => ({ state: { messages } }),
    authenticate: () => ({ member: { id: "mem-1" }, account: { id: "acc-1", authEpoch: 7 }, sessionBinding: "bind-1", sessionRevision: 3 }),
    transaction: fn => fn(),
    readTransaction: fn => fn(),
    now: () => 1700000000000
  };
  return new ThreadMutes(store);
}

test("thread-mutes: constructor refuses a store without a db handle", () => {
  assert.throws(() => new ThreadMutes({}), e => e.code === "thread_mute_store_missing" && e.status === 500);
  assert.throws(() => new ThreadMutes(null), e => e.code === "thread_mute_store_missing");
});

test("thread-mutes: muting a reply mutes its thread root, idempotently", () => {
  const mutes = threadMutesFixture();
  const set = mutes.set("tok", "room-1", { threadId: "grand-1", muted: true });
  assert.equal(set.threadId, "root-1");
  assert.equal(set.muted, true);
  assert.equal(set.viewerId, "mem-1");
  mutes.set("tok", "room-1", { threadId: "child-1", muted: true });
  assert.deepEqual([...mutes.list("tok", "room-1").threadIds], ["root-1"]);
  assert.deepEqual([...mutes.mutedThreadIds("room-1", "mem-1")], ["root-1"]);
  const unset = mutes.set("tok", "room-1", { threadId: "root-1", muted: false });
  assert.equal(unset.muted, false);
  assert.deepEqual([...mutes.list("tok", "room-1").threadIds], []);
});

test("thread-mutes: unknown and private threads 404, bad payloads 422", () => {
  const mutes = threadMutesFixture();
  assert.throws(() => mutes.set("tok", "room-1", { threadId: "nope", muted: true }), e => e.code === "message_not_found" && e.status === 404);
  assert.throws(() => mutes.set("tok", "room-1", { threadId: "dm-1", muted: true }), e => e.code === "message_not_found");
  assert.throws(() => mutes.set("tok", "room-1", { threadId: "root-1" }), e => e.code === "invalid_thread_mute" && e.status === 422);
  assert.throws(() => mutes.set("tok", "room-1", { threadId: "root-1", muted: "yes" }), e => e.code === "invalid_thread_mute");
  assert.throws(() => mutes.set("tok", "room-1", { threadId: "root-1", muted: true, extra: 1 }), e => e.code === "invalid_thread_mute");
});

// ---------- owner-delegates: grant/revoke lifecycle over a stub store ----------
function ownerDelegatesFixture({ asOwner = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(ownerDelegateSchema);
  const store = {
    db,
    authenticate: () => ({ member: { id: asOwner ? "owner-1" : "mem-x" } }),
    roomAuthority: () => ({ ownerId: "owner-1" }),
    identities: {
      resolveIdentityLink: (identityId) =>
        identityId === "ai_agent1" ? { member: { id: "mem-agent", kind: "agent" } } : null
    },
    transaction: fn => fn(),
    now: () => 1700000000000
  };
  return new OwnerDelegates(store);
}

test("owner-delegates: grant, list, journal and revoke follow the lifecycle", () => {
  const delegates = ownerDelegatesFixture();
  assert.equal(delegates.hasGrant("room-1", "ai_agent1"), false);
  const granted = delegates.grant("tok", "room-1", { identityId: "ai_agent1" });
  assert.deepEqual({ ...granted }, { roomId: "room-1", identityId: "ai_agent1", grantedBy: "owner-1", grantedAt: 1700000000000 });
  assert.equal(delegates.hasGrant("room-1", "ai_agent1"), true);
  assert.deepEqual(delegates.list("tok", "room-1").map(r => r.identityId), ["ai_agent1"]);
  assert.throws(() => delegates.grant("tok", "room-1", { identityId: "ai_agent1" }), e => e.code === "grant_active" && e.status === 409);
  delegates.revoke("tok", "room-1", { identityId: "ai_agent1" });
  assert.equal(delegates.hasGrant("room-1", "ai_agent1"), false);
  assert.deepEqual(delegates.journal("tok", "room-1").map(r => r.action), ["revoke", "grant"]);
  assert.throws(() => delegates.revoke("tok", "room-1", { identityId: "ai_agent1" }), e => e.code === "not_found" && e.status === 404);
  delegates.grant("tok", "room-1", { identityId: "ai_agent1" });
  assert.equal(delegates.revokeAllGrantedBy("room-1", "owner-1", { actorId: "account_deleted" }), 1);
  assert.equal(delegates.hasGrant("room-1", "ai_agent1"), false);
});

test("owner-delegates: only the owner grants, and only to linked agent identities", () => {
  const asMember = ownerDelegatesFixture({ asOwner: false });
  assert.throws(() => asMember.grant("tok", "room-1", { identityId: "ai_agent1" }), e => e.code === "access_denied" && e.status === 403);
  const delegates = ownerDelegatesFixture();
  assert.throws(() => delegates.grant("tok", "room-1", { identityId: "bad id!" }), e => e.code === "invalid_identity" && e.status === 422);
  assert.throws(() => delegates.grant("tok", "room-1", { identityId: "ai_unknown" }), e => e.code === "not_found" && e.status === 404);
  assert.equal(delegates.hasGrant("", ""), false);
});

// ---------- room-key-presence: credential-derived host ids and binding ----------
test("room-key-presence: host ids are namespaced under the credential prefix", () => {
  const auth = { hostPrefix: "rk_abc_" };
  const id = roomKeyHostId(auth, "host-1");
  assert.ok(id.startsWith("rk_abc_"));
  assert.equal(id.length, "rk_abc_".length + 48);
  assert.equal(roomKeyHostId(auth, "host-1"), id, "derivation is deterministic");
  assert.notEqual(roomKeyHostId(auth, "host-2"), id);
  assert.throws(() => roomKeyHostId(auth, "bad host!"), e => e.code === "invalid_heartbeat" && e.status === 422);
  assert.equal(scopedKeyHostId({ hostPrefix: "ak_x_" }, "my-host"), "ak_x_my-host");
});

test("room-key-presence: a scoped key binds exactly one room it is a member of", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT);");
  db.prepare("INSERT INTO identity_links VALUES(?,?,?)").run("room-1", "ai_1", "mem-1");
  const store = {
    db,
    room: () => ({ state: { members: { "mem-1": { id: "mem-1", active: true, kind: "agent", identityId: "ai_1" } } } })
  };
  assert.equal(scopedKeyRoomBinding(store, { keyId: null, identityId: "ai_1", scopes: ["mcp:room:room-1"] }), null);
  assert.equal(scopedKeyRoomBinding(store, { keyId: "k", identityId: "ai_1", scopes: ["rooms:read"] }), null);
  assert.throws(
    () => scopedKeyRoomBinding(store, { keyId: "k", identityId: "ai_1", scopes: ["mcp:room:room-1", "mcp:room:room-2"] }),
    e => e.code === "scoped_key_room_refused" && e.status === 403);
  const binding = scopedKeyRoomBinding(store, { keyId: "key-9", identityId: "ai_1", scopes: ["mcp:room:room-1"] });
  assert.equal(binding.roomId, "room-1");
  assert.ok(binding.hostPrefix.startsWith("ak_"));
});

test("room-key-presence: the presence view only surfaces this credential's pull-only hosts", () => {
  const store = {
    agentHeartbeats: {
      statusOf: () => ({ hosts: [
        { hostId: "rk_abc_h1", mode: "pull-only", state: "online", wakeUrl: "https://example.invalid/hook", lastSeenAt: 42 },
        { hostId: "someone-else", mode: "pull-only", state: "online", lastSeenAt: 99 }
      ] })
    }
  };
  const view = roomKeyPresenceView(store, { identityId: "ai_1", hostPrefix: "rk_abc_" });
  assert.equal(view.hosts.length, 1);
  assert.equal(view.hosts[0].wakeUrl, null);
  assert.equal(view.status, "online");
  assert.equal(view.lastSeenAt, 42);
});

// ---------- trial-task-store: the rail guard every rail route runs ----------
test("trial-task-store: railFail throws a shaped rail error", () => {
  assert.throws(() => railFail(422, "some_code", "a message"),
    e => e.status === 422 && e.code === "some_code" && e.message === "a message");
});

test("trial-task-store: railActor enforces active membership and write gates", () => {
  const state = {
    room: {},
    members: {
      "mem-1": { id: "mem-1", active: true, kind: "human", permissions: [] },
      "ag-1": { id: "ag-1", active: true, kind: "agent", permissions: [] },
      "ag-2": { id: "ag-2", active: true, kind: "agent", permissions: ["accept_work"] }
    }
  };
  const store = { room: () => ({ state }) };
  assert.equal(railActor(store, "room-1", "mem-1"), state);
  assert.throws(() => railActor(store, "room-1", "ghost"), e => e.code === "access_denied" && e.status === 403);
  assert.throws(() => railActor(store, "room-1", "ag-1", { writing: true }), e => e.code === "access_denied");
  assert.equal(railActor(store, "room-1", "ag-2", { writing: true }), state);
  state.room = { archivedAt: 123 };
  assert.throws(() => railActor(store, "room-1", "mem-1", { writing: true }), e => e.code === "room_archived" && e.status === 409);
  assert.equal(railActor(store, "room-1", "mem-1"), state, "reads still work in an archived room");
});

// ---------- opportunities: feed guards ----------
test("opportunities: the feed refuses a storeless call and bad room ids", () => {
  assert.equal(OPPORTUNITIES_DEFAULT_LIMIT, 50);
  assert.equal(OPPORTUNITIES_MAX_LIMIT, 100);
  assert.throws(() => buildOpportunitiesFeed({}, {}), e => e.code === "opportunities_store_missing" && e.status === 500);
  assert.throws(() => buildOpportunitiesFeed({ db: {} }, { roomId: "" }), e => e.code === "invalid_room" && e.status === 422);
  assert.throws(() => buildOpportunitiesFeed({ db: {} }, { roomId: "x".repeat(129) }), e => e.code === "invalid_room");
});

// ---------- work-help: the reconciliation audit's invariant paths ----------
test("work-help: an empty history with no retained help passes the audit", () => {
  assert.equal(auditWorkHelp({ workItems: {} }, []), undefined);
  assert.equal(auditWorkHelp({ workItems: {} }, [], { sequence: 0, projection: JSON.stringify({ workItems: {} }) }), undefined);
});

test("work-help: retained help state with no supporting events fails the audit", () => {
  assert.throws(() => auditWorkHelp({ workItems: {}, helpOffers: {} }, []), /operator reconciliation/);
});

// ---------- route tables: the registered surface is the behaviour ----------
test("routes/agents: the fleet route table registers exactly the overview route", () => {
  assert.equal(AGENT_FLEET_ROUTES.length, 1);
  const [route] = AGENT_FLEET_ROUTES;
  assert.equal(route.id, "agents-overview");
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/api/rooms/{roomId}/agents/overview");
  assert.equal(route.handler, agentsOverview);
  assert.ok(Object.isFrozen(AGENT_FLEET_ROUTES) && Object.isFrozen(route));
});

test("routes/code-drops: the code-drop route table is complete and frozen", () => {
  assert.deepEqual(CODE_DROP_ROUTES.map(r => r.id),
    ["code-drop-share", "code-drop-list", "code-drop-read", "code-drop-raw", "code-drop-check"]);
  const byId = Object.fromEntries(CODE_DROP_ROUTES.map(r => [r.id, r]));
  assert.equal(byId["code-drop-share"].method, "POST");
  assert.equal(byId["code-drop-share"].handler, shareCodeDrop);
  assert.deepEqual(byId["code-drop-share"].events, ["message.posted"]);
  assert.equal(byId["code-drop-list"].handler, listCodeDrops);
  assert.equal(byId["code-drop-read"].handler, readCodeDrop);
  assert.equal(byId["code-drop-raw"].handler, rawCodeDrop);
  assert.equal(byId["code-drop-raw"].path, "/api/rooms/{roomId}/code/{dropId}/raw");
  assert.equal(byId["code-drop-check"].handler, checkCodeDrop);
});

test("routes/desktop-auth: the desktop auth routes are public worker routes on one handler", () => {
  assert.deepEqual(DESKTOP_AUTH_ROUTES.map(r => [r.id, r.method, r.path]), [
    ["desktop-auth-start", "GET", "/api/auth/desktop/start"],
    ["desktop-auth-callback", "GET", "/api/auth/desktop/callback"],
    ["desktop-auth-session", "POST", "/api/auth/desktop/session"]
  ]);
  for (const route of DESKTOP_AUTH_ROUTES) {
    assert.equal(route.auth, "none");
    assert.equal(route.scope, "worker");
    assert.equal(route.handler, DESKTOP_AUTH_ROUTES[0].handler);
  }
});

test("routes/record-rails: the rail route table covers every service and action", () => {
  assert.equal(RECORD_RAIL_ROUTES.length, 26);
  const ids = RECORD_RAIL_ROUTES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "route ids are unique");
  for (const id of ["demigod-offers-list", "demigod-offers-create", "demigod-offers-present",
    "demigod-offers-document", "demigod-contracts-acknowledge", "demigod-contracts-terminate",
    "signoff-loops-submit", "signoff-loops-status", "trial-tasks-list", "trial-tasks-apply",
    "trial-tasks-read", "trial-tasks-receipt"])
    assert.ok(ids.includes(id), `route registered: ${id}`);
  const byId = Object.fromEntries(RECORD_RAIL_ROUTES.map(r => [r.id, r]));
  assert.equal(byId["demigod-offers-document"].path, "/api/rooms/{roomId}/demigod-offers/{recordId}/document");
  assert.equal(byId["trial-tasks-receipt"].path, "/api/rooms/{roomId}/trial-tasks/{recordId}/receipt");
  for (const route of RECORD_RAIL_ROUTES) {
    assert.equal(route.auth, "room");
    assert.equal(typeof route.handler, "function");
  }
});

test("routes/room-assistant: the assistant route table is GET/HEAD/POST on one path", () => {
  assert.deepEqual(ROOM_ASSISTANT_ROUTES.map(r => [r.id, r.method, r.path]), [
    ["room-assistant-get", "GET", "/api/rooms/{roomId}/assistant"],
    ["room-assistant-head", "HEAD", "/api/rooms/{roomId}/assistant"],
    ["room-assistant-post", "POST", "/api/rooms/{roomId}/assistant"]
  ]);
  for (const route of ROOM_ASSISTANT_ROUTES) assert.equal(route.handler, roomAssistantRoute);
  const post = ROOM_ASSISTANT_ROUTES.find(r => r.method === "POST");
  assert.ok(post.schema.body, "POST carries the command body schema");
  assert.equal(ROOM_ASSISTANT_ROUTES.find(r => r.method === "GET").schema.body, undefined);
});
