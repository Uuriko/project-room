// 405 Allow contract for the hand-dispatched auth/account and inbox
// surfaces (methods-audit depth wave, D1-3 F6 + D1-2 F-6): a 405 response
// must carry an Allow header listing exactly the methods the path serves
// (RFC 9110; the route-table dispatcher's stated intent, server/routes/
// auth.mjs header). The table dispatcher's own 405s already set Allow and
// are pinned in tests/route-table-parity.test.js; the handlers below
// dispatch themselves (legacy chain blocks and the inbox mount), and
// their reject(405) calls omitted the header.
//
// Authoring-gate answers (.agents/skills/test-audit/SKILL.md):
// 1. Protects the client-facing 405 contract: a caller told a method is
//    not allowed must be able to read which methods are, from Allow.
// 2. Credible regression: a hand-rolled method guard is copied from a
//    neighbouring handler without the headers argument — the exact shape
//    that produced every case below.
// 3. Existing coverage: route-table-parity pins Allow only for trie-
//    dispatched rows and the auth table group; no test probed a wrong
//    method on these legacy-chain or mount sub-handler paths.
// 4. No production seam: boots the real server on the acceptance fixture
//    with a real account session; Gmail is enabled through the existing
//    gmailAuth server option with an allow-all pilot config.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function boot(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({
    enableDeferredInbox: true,
    store: fixture.store,
    gmailAuth: { allowedAccountIds: null },
  });
  const origin = await listen(server);
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const account = fixture.store.accountForMember("commons", "owner");
  const key = fixture.store.issueAccountAccessKey(account.id);
  const slot = fixture.store.createAccountSessionSlot();
  const session = { token: slot.token, ...fixture.store.loginAccountSession(slot.token, key, 0) };
  const sessionHeaders = { Cookie: `account_session=${session.token}`, "X-Session-Binding": session.sessionBinding };
  return { origin, sessionHeaders };
}

async function expect405(origin, method, path, { headers, allow }) {
  const response = await fetch(`${origin}${path}`, { method, headers });
  assert.equal(response.status, 405, `${method} ${path}`);
  assert.equal(response.headers.get("allow"), allow, `${method} ${path} Allow`);
  assert.equal((await response.json()).error.code, "method_not_allowed", `${method} ${path} code`);
}

test("account-management paths answer a wrong method with 405 and Allow", async t => {
  const { origin } = await boot(t);
  await expect405(origin, "PUT", "/api/account/profile", { allow: "GET, POST" });
  await expect405(origin, "PUT", "/api/account/onboarding", { allow: "GET" });
  await expect405(origin, "GET", "/api/account/onboarding/complete", { allow: "POST" });
  await expect405(origin, "PUT", "/api/account/retention", { allow: "GET" });
  await expect405(origin, "PUT", "/api/account/deletion/plan", { allow: "GET" });
  await expect405(origin, "GET", "/api/account/delete", { allow: "POST" });
});

test("auth method-management paths answer a wrong method with 405 and Allow", async t => {
  const { origin } = await boot(t);
  await expect405(origin, "POST", "/api/auth/methods", { allow: "GET" });
  await expect405(origin, "GET", "/api/auth/methods/disable", { allow: "POST" });
  await expect405(origin, "GET", "/api/auth/methods/enable", { allow: "POST" });
  await expect405(origin, "GET", "/api/auth/methods/remove", { allow: "POST" });
  await expect405(origin, "GET", "/api/auth/password/set", { allow: "POST" });
  await expect405(origin, "POST", "/api/auth/github/link/start", { allow: "GET" });
  await expect405(origin, "POST", "/api/auth/google/link/start", { allow: "GET" });
});

test("inbox mount sub-handlers answer a wrong method with 405 and Allow", async t => {
  const { origin, sessionHeaders } = await boot(t);
  await expect405(origin, "GET", "/api/inbox/webhooks/conn-1", { allow: "POST" });
  await expect405(origin, "DELETE", "/api/inbox/setup", { headers: sessionHeaders, allow: "GET, POST" });
  await expect405(origin, "GET", "/api/inbox/gmail/sync", { headers: sessionHeaders, allow: "POST" });
});
