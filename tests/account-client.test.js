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
  assert.equal(streamUrls[0], "/api/rooms/room%3Aone/stream?after=7&auth=account");

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
