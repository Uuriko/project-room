// Route table (batch RT). These tests own fallthrough for paths still on the
// legacy chain, the dispatcher's 405 Allow contract, the inbox mount's
// session checks, the auth group's status and error-code parity, and the
// gates that keep the OpenAPI document and the legacy allowlist honest.
// Recorded per-route parity rows join this file as later groups leave the
// legacy chain.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ServiceError } from "../server/service-error.mjs";
import { ROUTES, assertRouteRow, assertRouteTable } from "../server/routes/table.mjs";
import { AUTH_ROUTES } from "../server/routes/auth.mjs";
import { INBOX_ROUTES } from "../server/routes/inbox.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { dispatchRoute } from "../server/routes/dispatch.mjs";
import { EVENT_TYPES } from "../src/events.js";
import { allowlistProblems, extractLegacyRoutes, loadRouteSources } from "../scripts/routes-inventory.mjs";
import { methodCoverageProblems, openApiParseErrors } from "../scripts/openapi-gen.mjs";
import { openapiOperations } from "../scripts/open-routes.mjs";

const root = new URL("..", import.meta.url);

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test("paths outside the route table stay on the legacy chain", async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  const origin = await listen(server);
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const missing = await fetch(`${origin}/api/rt0-no-such-route`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
});

test("a known path with the wrong method answers 405 and Allow", async t => {
  const routes = [{
    id: "probe",
    method: "GET",
    path: "/api/probe/{id}",
    auth: "none",
    capability: null,
    handler(ctx) { ctx.json(ctx.res, 200, { id: ctx.params.id }); },
    schema: { response: { type: "object" } },
    events: [],
    scope: "public",
  }];
  let authorized = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      const handled = await dispatchRoute({
        req, res, url,
        json(response, status, value) {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(value));
        },
        reject: (status, code, message) => { throw new ServiceError(status, code, message); },
        authorize() { authorized = true; },
      }, routes);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        res.writeHead(error.status);
        res.end(JSON.stringify({ error: { code: error.code } }));
        return;
      }
      throw error;
    }
  });
  const origin = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const wrong = await fetch(`${origin}/api/probe/room-1`, { method: "POST" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
  assert.equal((await wrong.json()).error.code, "method_not_allowed");
  assert.equal(authorized, false);
  const ok = await fetch(`${origin}/api/probe/room-1`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: "room-1" });
  const other = await fetch(`${origin}/api/other`);
  assert.equal(other.status, 404);
});

test("inbox mounts require an account session before they choose a method", async t => {
  const fixture = createAcceptanceFixture();
  const account = fixture.store.accountForMember("commons", "owner");
  const key = fixture.store.issueAccountAccessKey(account.id);
  const slot = fixture.store.createAccountSessionSlot();
  const session = { token: slot.token, ...fixture.store.loginAccountSession(slot.token, key, 0) };
  const server = createRoomServer({ store: fixture.store });
  const origin = await listen(server);
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const headers = { Cookie: `account_session=${session.token}`, "X-Session-Binding": session.sessionBinding };

  const anonymous = await fetch(`${origin}/api/inbox`);
  assert.equal(anonymous.status, 422);
  assert.equal((await anonymous.json()).error.code, "session_binding_required");

  const missingSession = await fetch(`${origin}/api/inbox`, { headers: { "X-Session-Binding": "a".repeat(64) } });
  assert.equal(missingSession.status, 401);
  assert.equal((await missingSession.json()).error.code, "unauthenticated");

  const bearer = await fetch(`${origin}/api/inbox`, { headers: { Authorization: "Bearer not-a-session" } });
  assert.equal(bearer.status, 401);
  assert.equal((await bearer.json()).error.code, "account_session_required");

  const list = await fetch(`${origin}/api/inbox`, { headers });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).contractVersion, 1);

  const wrongMethod = await fetch(`${origin}/api/inbox`, { method: "POST", headers });
  assert.equal(wrongMethod.status, 404);
  assert.equal((await wrongMethod.json()).error.code, "not_found");

  const missingCsrf = await fetch(`${origin}/api/inbox/commands`, {
    method: "POST",
    headers: { ...headers, Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, "csrf_denied");

  const bearerWrite = await fetch(`${origin}/api/inbox/commands`, {
    method: "POST",
    headers: { Authorization: "Bearer not-a-session", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(bearerWrite.status, 401);
  assert.equal((await bearerWrite.json()).error.code, "account_session_required");

  const setup = await fetch(`${origin}/api/inbox/setup`, { method: "DELETE", headers });
  assert.equal(setup.status, 405);
  assert.equal((await setup.json()).error.code, "method_not_allowed");

  const listRow = INBOX_ROUTES.find(row => row.id === "inbox.list");
  assert.equal(listRow.auth, "account");
  assert.equal(listRow.mount, true);
  assert.equal(listRow.path, "/api/inbox");
});

test("auth routes keep their status, error code, and 405 Allow", async t => {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({
    store: fixture.store,
    magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); } }),
  });
  const origin = await listen(server);
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const codeOf = async response => (await response.json()).error.code;
  const post = (path, { cookie, csrf, bearer, body, originHeader = origin } = {}) => fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(originHeader ? { Origin: originHeader } : {}),
      ...(cookie ? { Cookie: `account_session=${cookie}` } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const openSlot = async () => {
    const response = await fetch(`${origin}/api/account-session`);
    assert.equal(response.status, 200);
    const view = await response.json();
    const cookie = /account_session=([A-Za-z0-9_-]{43})/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    return { cookie, csrf: view.csrf, revision: view.sessionRevision };
  };
  const slotToken = () => {
    const slot = fixture.store.createAccountSessionSlot();
    return { sessionToken: slot.token, sessionRevision: slot.session.sessionRevision };
  };

  for (const row of AUTH_ROUTES) {
    assert.equal(row.method, "POST", row.id);
    const wrong = await fetch(`${origin}${row.path}`);
    assert.equal(wrong.status, 405, row.path);
    assert.equal(wrong.headers.get("allow"), "POST", row.path);
    assert.equal((await wrong.json()).error.code, "method_not_allowed");
  }

  const anonymousCookie = [
    "/api/auth/magic/request",
    "/api/auth/magic/consume",
    "/api/auth/password/reset/request",
    "/api/auth/password/reset/consume",
    "/api/auth/password/change",
    "/api/auth/passkey/register/options",
    "/api/auth/passkey/register/finish",
  ];
  for (const path of anonymousCookie) {
    const response = await post(path, { body: {} });
    assert.equal(response.status, 401, path);
    assert.equal(await codeOf(response), "account_session_required", path);
  }

  const slot = await openSlot();
  const missingCsrf = await post("/api/auth/magic/request", { cookie: slot.cookie, body: { email: "rt1@example.invalid" } });
  assert.equal(missingCsrf.status, 403);
  assert.equal(await codeOf(missingCsrf), "csrf_denied");

  const bearerWrite = await post("/api/auth/magic/request", { bearer: "not-a-session", body: { email: "rt1@example.invalid" } });
  assert.equal(bearerWrite.status, 401);
  assert.equal(await codeOf(bearerWrite), "account_session_required");

  const requested = await post("/api/auth/magic/request", { cookie: slot.cookie, csrf: slot.csrf, body: { email: "Ada@Example.INVALID" } });
  assert.equal(requested.status, 200);
  assert.deepEqual(await requested.json(), { status: "sent" });
  assert.equal(sent.at(-1).to, "ada@example.invalid");
  const consumed = await post("/api/auth/magic/consume", {
    cookie: slot.cookie, csrf: slot.csrf,
    body: { email: "ada@example.invalid", code: sent.at(-1).code, sessionRevision: slot.revision },
  });
  assert.equal(consumed.status, 201);
  assert.equal((await consumed.json()).authenticated, true);

  const resetSlot = await openSlot();
  const resetRequested = await post("/api/auth/password/reset/request", {
    cookie: resetSlot.cookie, csrf: resetSlot.csrf, body: { email: "reset@example.invalid" },
  });
  assert.equal(resetRequested.status, 200);
  assert.deepEqual(await resetRequested.json(), { status: "sent" });
  const resetConsumed = await post("/api/auth/password/reset/consume", {
    cookie: resetSlot.cookie, csrf: resetSlot.csrf,
    body: { email: "reset@example.invalid", code: "not-the-code", newPassword: "a-new-password-value", sessionRevision: resetSlot.revision },
  });
  assert.equal(resetConsumed.status, 401);
  assert.equal(await codeOf(resetConsumed), "invalid_password_reset");

  const signupBody = { email: "rt1-signup@example.invalid", password: "fixture-password-long-enough", ...slotToken() };
  const bareSignup = await post("/api/auth/password/signup", { body: { email: signupBody.email, password: signupBody.password, sessionRevision: 0 } });
  assert.equal(bareSignup.status, 401);
  assert.equal(await codeOf(bareSignup), "account_session_required");
  const signedUp = await post("/api/auth/password/signup", { body: signupBody });
  assert.equal(signedUp.status, 202);
  assert.deepEqual(await signedUp.json(), { status: "check_email", mailConfigured: true });
  const signupCookie = /account_session=([A-Za-z0-9_-]{43})/.exec(signedUp.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(signupCookie);

  const bareLogin = await post("/api/auth/password/login", {
    body: { email: signupBody.email, password: signupBody.password, sessionRevision: 0 },
  });
  assert.equal(bareLogin.status, 401);
  assert.equal(await codeOf(bareLogin), "account_session_required");
  const loggedIn = await post("/api/auth/password/login", {
    body: { email: signupBody.email, password: signupBody.password, ...slotToken() },
  });
  assert.equal(loggedIn.status, 200);
  assert.equal((await loggedIn.json()).authenticated, true);

  const changed = await post("/api/auth/password/change", {
    cookie: signupCookie,
    body: { currentPassword: signupBody.password, newPassword: "brand-new-password-99" },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { status: "ok" });

  const passkeyAccount = "rt1-passkey";
  fixture.store.createAccount(passkeyAccount);
  const passkeyKey = fixture.store.issueAccountAccessKey(passkeyAccount);
  const passkeySlot = fixture.store.createAccountSessionSlot();
  const passkeySession = fixture.store.loginAccountSession(passkeySlot.token, passkeyKey, 0);
  const registerOptions = await post("/api/auth/passkey/register/options", {
    cookie: passkeySlot.token, csrf: passkeySession.csrf, body: {},
  });
  assert.equal(registerOptions.status, 200);
  assert.equal(typeof (await registerOptions.json()).challengeId, "string");
  const registerFinish = await post("/api/auth/passkey/register/finish", {
    cookie: passkeySlot.token, csrf: passkeySession.csrf,
    body: { challengeId: "nope", response: {} },
  });
  assert.equal(registerFinish.status, 401);
  assert.equal(await codeOf(registerFinish), "invalid_passkey_challenge");

  const authOptions = await post("/api/auth/passkey/authenticate/options", { body: {} });
  assert.equal(authOptions.status, 200);
  assert.equal(typeof (await authOptions.json()).challengeId, "string");
  const bearerOptions = await post("/api/auth/passkey/authenticate/options", { bearer: "not-a-session", body: {} });
  assert.equal(bearerOptions.status, 200);
  const bareFinish = await post("/api/auth/passkey/authenticate/finish", {
    body: { challengeId: "nope", response: {}, sessionRevision: 0 },
  });
  assert.equal(bareFinish.status, 401);
  assert.equal(await codeOf(bareFinish), "account_session_required");
  const authFinish = await post("/api/auth/passkey/authenticate/finish", {
    body: { challengeId: "nope", response: {}, ...slotToken() },
  });
  assert.equal(authFinish.status, 401);
  assert.equal(await codeOf(authFinish), "invalid_passkey_challenge");
});

test("docs/openapi.yaml parses as OpenAPI 3.1", () => {
  const text = readFileSync(new URL("docs/openapi.yaml", root), "utf8");
  assert.deepEqual(openApiParseErrors(text), []);
  assert.match(text, /^openapi: 3\.1\.0/m);
});

test("documented operations are served, and HEAD is covered by GET", () => {
  const synthetic = methodCoverageProblems(
    [{ method: "HEAD", path: "/api/agents/{id}/card" }, { method: "POST", path: "/api/missing" }],
    [{ method: "GET", path: "/api/agents/{agentId}/card" }],
    []
  );
  assert.deepEqual(synthetic, [
    "documented operation is not in the route table or the legacy allowlist: POST /api/missing",
  ]);
  const text = readFileSync(new URL("docs/openapi.yaml", root), "utf8");
  const problems = methodCoverageProblems(
    openapiOperations(text),
    extractLegacyRoutes(loadRouteSources(root.pathname)),
    ROUTES
  );
  assert.deepEqual(problems, []);
});

test("the legacy allowlist matches the chain and only shrinks", () => {
  const grown = allowlistProblems(
    [{ method: "GET", path: "/api/new" }],
    { baseline: [], routes: [] }
  );
  assert.ok(grown.some(line => line.includes("not in the RT-0 baseline")));
  const document = JSON.parse(readFileSync(new URL("scripts/routes-legacy-allowlist.json", root), "utf8"));
  assert.deepEqual(allowlistProblems(extractLegacyRoutes(loadRouteSources(root.pathname)), document), []);
});

test("every route row names auth, scope, schema, and a null-or-string capability", () => {
  const rejected = assertRouteRow({
    id: "",
    method: "GET",
    path: "/api/x",
    auth: "none",
    capability: 1,
    handler() {},
    schema: {},
    events: "no",
    scope: "desk",
  });
  for (const field of ["id", "capability", "schema", "events", "scope"]) assert.ok(rejected.includes(field), field);
  assert.throws(() => assertRouteTable([{ ...probeRow(), id: "" }]), /route table rejected/);
  const known = new Set(Object.values(EVENT_TYPES));
  for (const row of ROUTES) {
    assert.deepEqual(assertRouteRow(row), []);
    assert.ok(row.capability === null || typeof row.capability === "string");
    for (const event of row.events) assert.ok(known.has(event), event);
  }
});

function probeRow() {
  return {
    id: "probe",
    method: "GET",
    path: "/api/probe",
    auth: "none",
    capability: null,
    handler() {},
    schema: { response: { type: "object" } },
    events: [],
    scope: "public",
  };
}
