// QA r18 (John's Tab), sibling of #2434 (deleted-email-reuse): after a Google or
// GitHub sign-up deletes its account, signing in with the same provider again
// must start a fresh account. Before the fix linkGoogleSubject/linkGitHubSubject
// find the google:<sub> / github:<id> tombstone (the login methods were deleted,
// the deactivated row stays), skip createAccount, and the callback lands on
// ?google=error / ?github=error: the person is locked out for good.
import test from "node:test";
import assert from "node:assert/strict";
import { googleAuth } from "../scripts/helpers/google-oauth-fixture.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";
import { GITHUB_START_PATH, GITHUB_CALLBACK_PATH, GITHUB_SCOPES } from "../server/github-oauth.mjs";

async function start(t, options = { googleAuth: googleAuth() }) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  return { f, origin: `http://127.0.0.1:${server.address().port}` };
}
async function deleteAccount(origin, token, csrf) {
  const creds = { Cookie: `account_session=${token}` };
  const plan = await (await fetch(origin + "/api/account/deletion/plan", { headers: creds })).json();
  const del = await fetch(origin + "/api/account/delete", { method: "POST",
    headers: { ...creds, "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf },
    body: JSON.stringify({ confirmationToken: plan.confirmationToken }) });
  assert.equal(del.status, 200, "the first account is deleted");
}
const cookieOf = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;
async function googleSignIn(origin) {
  const startRes = await fetch(origin + GOOGLE_START_PATH, { redirect: "manual" });
  const state = new URL(startRes.headers.get("location")).searchParams.get("state");
  return fetch(`${origin}${GOOGLE_CALLBACK_PATH}?state=${state}&code=code-${Math.random()}`,
    { redirect: "manual", headers: { Cookie: `account_session=${cookieOf(startRes)}` } });
}

test("a deleted Google account can sign in with Google again and gets a fresh, working account", async t => {
  const { f, origin } = await start(t);
  const first = await googleSignIn(origin);
  assert.equal(first.status, 200);
  const token = cookieOf(first);
  const session = f.store.authenticateAccountSession(token);
  const firstId = session.account.id;
  await deleteAccount(origin, token, session.csrf);

  const again = await googleSignIn(origin);
  const html = await again.text();
  assert.equal(again.status, 200);
  assert.doesNotMatch(html, /google=error/, "signing in with Google again does not land on the Google sign-in error");
  assert.ok(cookieOf(again), "the callback sets a signed-in session");
  const next = f.store.authenticateAccountSession(cookieOf(again));
  assert.ok(next.account?.id, "the new sign-in has an account");
  assert.notEqual(next.account.id, firstId, "a new account, not the deactivated tombstone");
});

const GITHUB_ID = 515151;
function githubAuthStub() {
  const fetchImpl = async url => {
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_fixture", token_type: "bearer", scope: GITHUB_SCOPES });
    if (url === "https://api.github.com/user") return Response.json({ id: GITHUB_ID, login: "came-back" });
    if (url === "https://api.github.com/user/emails") return Response.json([{ email: "gh-came-back@example.com", primary: true, verified: true }]);
    return new Response("missing", { status: 404 });
  };
  return { clientId: "Iv1.fixtureclientid0000", clientSecret: "fixture-secret-never-real", fetchImpl };
}
async function githubSignIn(f, origin) {
  const slot = f.store.createAccountSessionSlot();
  const startRes = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${slot.token}`, { redirect: "manual" });
  const state = new URL(startRes.headers.get("location")).searchParams.get("state");
  return fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${state}&code=code-${Math.random()}`, { redirect: "manual" });
}

test("a deleted GitHub account can sign in with GitHub again and gets a fresh, working account", async t => {
  const { f, origin } = await start(t, { githubAuth: githubAuthStub() });
  const first = await githubSignIn(f, origin);
  const token = cookieOf(first);
  assert.ok(token, `first GitHub sign-in sets a session (got ${first.status})`);
  const session = f.store.authenticateAccountSession(token);
  const firstId = session.account.id;
  await deleteAccount(origin, token, session.csrf);

  const again = await githubSignIn(f, origin);
  const html = await again.text();
  assert.doesNotMatch(html, /github=error/, "signing in with GitHub again does not land on the GitHub sign-in error");
  assert.ok(cookieOf(again), `the callback sets a signed-in session (got ${again.status} ${html.slice(0, 120)})`);
  const next = f.store.authenticateAccountSession(cookieOf(again));
  assert.ok(next.account?.id, "the new sign-in has an account");
  assert.notEqual(next.account.id, firstId, "a new account, not the deactivated tombstone");
});
