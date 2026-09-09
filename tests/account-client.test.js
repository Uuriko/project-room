import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient, RoomClient, RoomSessionClient } from "../src/client.js";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const accountSession = (id, sessionRevision, suffix = sessionRevision) => ({
  authenticated: id !== null,
  account: id === null ? null : { id, revision: 0, authEpoch: 0 },
  csrf: `csrf-${suffix}`,
  sessionBinding: `binding-${suffix}`,
  sessionRevision,
  expiresAt: 999999,
  authenticatedUntil: id === null ? null : 888888
});

test("account confirmation preserves ownership on a matching read and invalidates a changed account", async () => {
  const original = accountSession("personal", 2); let remote = original;
  const client = new AccountClient({ fetcher: async () => response(remote) }); client.session = original;
  assert.equal(await client.confirm(), true); assert.equal(client.session, original); assert.equal(client.generation, 0);
  remote = accountSession("replacement", 3);
  assert.equal(await client.confirm(), false); assert.equal(client.session, null); assert.equal(client.generation, 1);
});
test("late account confirmation cannot invalidate a replacement; network failure is not logout", async () => {
  const pending = deferred(), client = new AccountClient({ fetcher: () => pending.promise });
  client.session = accountSession("old", 1); const checking = client.confirm();
  const replacement = accountSession("new", 2); client.generation++; client.session = replacement;
  pending.resolve(response(accountSession(null, 3))); assert.equal(await checking, null); assert.equal(client.session, replacement);
  client.fetcher = async () => { throw new Error("Offline"); };
  await assert.rejects(client.confirm(), /Offline/); assert.equal(client.session, replacement);
});
test("room discovery pins the account and rejects malformed or nonprogressing pages", async () => {
  const original = accountSession("personal", 1), calls = [];
  let data = { contractVersion: 1, viewer: { accountId: original.account.id, authEpoch: 0, sessionRevision: 1, sessionBinding: original.sessionBinding },
    rooms: [{ id: "commons", title: "Commons", memberId: "owner" }], nextCursor: null };
  const client = new AccountClient({ fetcher: async (path, options) => { calls.push({ path, options }); return response(data); } }); client.session = original;
  assert.equal((await client.rooms()).rooms[0].id, "commons");
  assert.equal(calls[0].options.headers["X-Session-Binding"], original.sessionBinding);
  data = { ...data, nextCursor: "commons" }; await assert.rejects(client.rooms("commons"), /order|continuation/);
  data = { ...data, viewer: { ...data.viewer, accountId: "other" } };
  await assert.rejects(client.rooms(), /Account changed/); assert.equal(client.session, null);
});

test("a delayed link join cannot replace a newer browser identity", async () => {
  const waiting = deferred(), replacement = accountSession("replacement", 3);
  const client = new AccountClient({ fetcher: async path => path === "/api/share-links/join" ? waiting.promise : response(replacement) });
  client.session = accountSession(null, 0);
  const joining = client.joinShareLink({ linkToken: "test-link", displayName: "Guest", redemptionId: "test-redemption" });
  await client.restore();
  waiting.resolve(response({ roomId: "commons", session: { ...accountSession("old-guest", 1), roomId: "commons", member: { id: "old-guest", kind: "human" } } }));
  assert.equal(await joining, null);
  assert.equal(client.session, replacement);
});

test("an uncertain link join invalidates the client view before a same-ID retry", async () => {
  const client = new AccountClient({ fetcher: async () => { throw new Error("Simulated lost response"); } });
  client.session = accountSession(null, 0);
  await assert.rejects(client.joinShareLink({ linkToken: "test-link", displayName: "Guest", redemptionId: "test-redemption" }), /lost response/);
  assert.equal(client.session, null);
});

test("invitation preview preserves existing account ownership and sends no credentials", async () => {
  const current = accountSession("current", 2), calls = [];
  const client = new AccountClient({ fetcher: async (path, options) => {
    calls.push({ path, options }); return response({ room: { id: "commons" } });
  } });
  client.session = current; client.generation = 4;
  const prepared = await client.prepareShareLink("preview-token");
  assert.equal(prepared.session, current); assert.equal(client.session, current);
  assert.equal(client.generation, 4); assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/share-links/preview");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers["X-CSRF-Token"], undefined);
});

test("preparing an invitation without a client session restores a browser slot once", async () => {
  const restored = accountSession(null, 0), calls = [];
  const client = new AccountClient({ fetcher: async path => {
    calls.push(path); return response(path === "/api/account-session" ? restored : { room: { id: "commons" } });
  } });
  const result = await client.prepareShareLink("preview-token");
  assert.equal(result.session, restored);
  assert.deepEqual(calls, ["/api/share-links/preview", "/api/account-session"]);
});

test("authenticated link acceptance and ordinary link rejection retain open Room ownership", async () => {
  const current = accountSession("current", 2);
  let rejectLink = false;
  const client = new AccountClient({ fetcher: async () => rejectLink
    ? response({ error: { code: "link_unavailable", message: "Link expired" } }, 410)
    : response({ roomId: "commons", session: { ...current, roomId: "commons", member: { id: "human", kind: "human" } } }) });
  client.session = current; client.generation = 5;
  const join = () => client.joinShareLink({ linkToken: "test-link", displayName: "Human", redemptionId: "test-redemption" });
  assert.equal((await join()).roomId, "commons");
  assert.equal(client.session, current); assert.equal(client.generation, 5);
  rejectLink = true;
  await assert.rejects(join(), /Link expired/);
  assert.equal(client.session, current); assert.equal(client.generation, 5);
});

test("account bootstrap, login, and logout use the stable cookie slot with CSRF and revision CAS", async () => {
  const bootstrap = accountSession(null, 0);
  const loggedIn = accountSession("account-human", 1);
  const loggedOut = accountSession(null, 2);
  const replies = [bootstrap, loggedIn, loggedOut];
  const calls = [];
  const client = new AccountClient({ fetcher: async (path, options) => {
    calls.push({ path, options });
    return response(replies.shift(), options.method === "POST" ? 201 : 200);
  } });

  assert.equal(await client.restore(), bootstrap);
  assert.equal(await client.login("account-access-key"), loggedIn);
  assert.equal(await client.logout(), loggedOut);
  assert.equal(client.session, loggedOut);
  assert.equal(client.generation, 3);

  assert.equal(calls[0].path, "/api/account-session");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(calls[0].options.headers, {});

  assert.equal(calls[1].path, "/api/account-session");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    accountAccessKey: "account-access-key",
    expectedSessionRevision: 0
  });
  assert.equal(calls[1].options.headers["X-CSRF-Token"], bootstrap.csrf);
  assert.equal(calls[1].options.headers["X-Session-Binding"], bootstrap.sessionBinding);
  assert.equal(Object.hasOwn(calls[1].options.headers, "Cookie"), false, "JavaScript never reads or supplies the HttpOnly cookie");

  assert.equal(calls[2].options.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[2].options.body), { expectedSessionRevision: 1 });
  assert.equal(calls[2].options.headers["X-CSRF-Token"], loggedIn.csrf);
  assert.equal(calls[2].options.headers["X-Session-Binding"], loggedIn.sessionBinding);
});

test("a late login response cannot replace a newer restored account session", async () => {
  const bootstrap = accountSession(null, 0);
  const oldLogin = deferred();
  const replacementRestore = deferred();
  const client = new AccountClient({ fetcher: async (path, options) => {
    if (path === "/api/account-session" && options.method === "POST") return oldLogin.promise;
    if (path === "/api/account-session" && options.method === "GET") return replacementRestore.promise;
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  } });
  client.session = bootstrap;

  const loggingIn = client.login("old-account-key");
  const restoring = client.restore();
  const replacement = accountSession("account-replacement", 4, "replacement");
  replacementRestore.resolve(response(replacement));
  assert.equal(await restoring, replacement);
  oldLogin.resolve(response(accountSession("account-old", 1, "old"), 201));

  assert.equal(await loggingIn, null);
  assert.equal(client.session, replacement);
  assert.equal(client.session.account.id, "account-replacement");
});

test("stale account-session and binding rejections force a fresh restore", async () => {
  const cases = [
    {
      method: client => client.login("account-key"),
      status: 409,
      code: "stale_session_revision",
      message: "Account session changed"
    },
    {
      method: client => client.acceptInvitation({ invitationToken: "invitation-secret", redemptionId: "redemption", expectedRevision: 0 }),
      status: 409,
      code: "session_binding_changed",
      message: "Account session binding changed"
    }
  ];
  for (const item of cases) {
    const client = new AccountClient({ fetcher: async () => response({ error: { code: item.code, message: item.message } }, item.status) });
    client.session = item.code === "stale_session_revision"
      ? accountSession(null, 0)
      : accountSession("account-human", 2);
    await assert.rejects(item.method(client), new RegExp(item.message));
    assert.equal(client.session, null);
  }
});

test("invitation preview omits credentials and acceptance is bound to the current account session", async () => {
  const current = accountSession("account-target", 3, "target");
  const calls = [];
  let mismatched = false;
  const client = new AccountClient({ fetcher: async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/invitations/preview") return response({ id: "invite-one", roomId: "commons", status: "pending", revision: 0 });
    if (path === "/api/invitations/accept") {
      const owner = mismatched ? accountSession("account-other", 3, "other") : current;
      return response({ duplicate: false, session: { ...owner, roomId: "commons", member: { id: "target-member" } } }, 201);
    }
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  } });
  client.session = current;

  const preview = await client.previewInvitation("invitation-secret");
  assert.equal(preview.id, "invite-one");
  assert.equal(calls[0].options.credentials, "omit");
  assert.deepEqual(calls[0].options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].options.body), { invitationToken: "invitation-secret" });

  const accepted = await client.acceptInvitation({ invitationToken: "invitation-secret", redemptionId: "redemption-one", expectedRevision: 0 });
  assert.equal(accepted.session.account.id, "account-target");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[1].options.headers["X-CSRF-Token"], current.csrf);
  assert.equal(calls[1].options.headers["X-Session-Binding"], current.sessionBinding);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    invitationToken: "invitation-secret",
    redemptionId: "redemption-one",
    expectedRevision: 0
  });

  mismatched = true;
  assert.equal(await client.acceptInvitation({ invitationToken: "invitation-secret", redemptionId: "redemption-two", expectedRevision: 0 }), null);
  assert.equal(client.session, null, "an unowned acceptance response fails closed");
});

test("Room account mode carries auth and binding through restore, writes, and SSE without weakening legacy mode", async () => {
  assert.equal(RoomSessionClient, RoomClient);
  const owner = accountSession("account-human", 5, "room-owner");
  let accountRequests = 0;
  const accountClient = new AccountClient({ fetcher: async () => { accountRequests++; throw new Error("replacement account must not be signed out"); } });
  accountClient.session = owner;
  accountClient.generation = 8;
  const calls = [], streamUrls = [], seen = [];
  class Events {
    constructor(url) { streamUrls.push(url); }
    addEventListener() {}
    close() {}
  }
  const roomSession = {
    authMode: "account",
    account: owner.account,
    member: { id: "human", kind: "human" },
    roomId: "room:one",
    csrf: owner.csrf,
    sessionBinding: owner.sessionBinding,
    sessionRevision: owner.sessionRevision
  };
  const client = new RoomClient({ accountClient, events: Events, onSnapshot: snapshot => seen.push(snapshot.sequence), fetcher: async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith("/api/session?room=")) return response(roomSession);
    if (path.endsWith("/cursor")) return response({ cursor: 7 });
    return response({
      sequence: 7,
      roomId: roomSession.roomId,
      state: {},
      cursor: 0,
      viewerId: roomSession.member.id,
      viewerAccountId: owner.account.id,
      viewerAuthEpoch: owner.account.authEpoch,
      viewerSessionBinding: owner.sessionBinding,
      viewerSessionRevision: owner.sessionRevision
    });
  } });

  assert.equal(await client.restore("room:one"), roomSession);
  assert.deepEqual(seen, [7]);
  assert.equal(calls[0].path, "/api/session?room=room%3Aone");
  assert.equal(calls[1].path, "/api/rooms/room%3Aone");
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.options.headers["X-Project-Room-Auth"], "account");
    assert.equal(call.options.headers["X-Session-Binding"], owner.sessionBinding);
  }
  assert.equal(streamUrls[0], "/api/rooms/room%3Aone/stream?after=7&auth=account&binding=binding-room-owner");

  assert.deepEqual(await client.caughtUp(7), { cursor: 7 });
  assert.equal(calls[2].options.headers["X-Project-Room-Auth"], "account");
  assert.equal(calls[2].options.headers["X-Session-Binding"], owner.sessionBinding);
  assert.equal(calls[2].options.headers["X-CSRF-Token"], owner.csrf);

  const replacement = accountSession("account-replacement", 6, "replacement");
  accountClient.generation++;
  accountClient.session = replacement;
  assert.equal(await client.logout(), null);
  assert.equal(accountRequests, 0, "a stale Room cannot log out the replacement account");
  assert.equal(client.session, null);
  assert.equal(accountClient.session, replacement);
});
