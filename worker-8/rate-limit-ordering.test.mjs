// WORKER 8 — fail-first test: /api/account/delete rate-limits BEFORE auth on a
// shared per-IP key, so 5 anonymous requests from one IP lock every legitimate
// user behind that IP out of account deletion for a minute.
//
// server/http.mjs:2398-2403 (branch wave2000/guild-02 @ 747f101f8):
//   if (req.method !== "POST") reject(405, ...);
//   checkOrigin(req, true);
//   rate(`account-delete:${remoteAddress}`, 5);   // <-- before auth, shared IP key
//   const session = requireAccountSession();     // <-- auth happens here
//
// Contrast the sibling routes on the same file, which do it the safe way:
//   /api/account/deletion/plan :2386 — requireAccountSession() THEN rate()
//   /api/auth/email/verify/resend :1214 — rate(`email-verify-resend:${account.id}`, 5) after auth
//
// Expected (post-fix): key on the authenticated account id, or rate after auth,
// so the legitimate delete below returns 200. Currently it returns 429.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

test("account/delete: anonymous requests must not burn a legitimate user's deletion budget", async (t) => {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
    try { fixture.store.close(); } catch {}
  });

  // Legitimate user: sign up, get a deletion plan token.
  const email = `w8-ratelimit-${Date.now() % 1000000}@example.invalid`;
  const slot = fixture.store.createAccountSessionSlot();
  const signup = await fetch(base + "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, password: "fixture-password-x-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  assert.equal(signup.status, 202, await signup.text());
  const token = /account_session=([^;]+)/.exec(signup.headers.get("set-cookie") || "")?.[1];
  assert.ok(token);
  const session = fixture.store.authenticateAccountSession(token);
  const cookie = `account_session=${token}`;
  const plan = await (await fetch(base + "/api/account/deletion/plan", { headers: { Cookie: cookie } })).json();
  assert.ok(plan.confirmationToken, "plan issues a confirmation token");

  // Attacker (or just a noisy neighbor on the same NAT/VPN exit IP): 5 anonymous
  // POSTs. checkOrigin is satisfied with a plain Origin header; no cookie needed.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(base + "/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ confirmationToken: "junk" }),
    });
    assert.equal(r.status, 401, `anonymous probe ${i + 1} should 401 after burning one bucket token`);
  }

  // The legitimate, authenticated, CSRF'd delete must still go through.
  const del = await fetch(base + "/api/account/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie, "X-CSRF-Token": session.csrf },
    body: JSON.stringify({ confirmationToken: plan.confirmationToken }),
  });
  assert.equal(del.status, 200, `legitimate delete blocked: ${await del.text()}`);
});
