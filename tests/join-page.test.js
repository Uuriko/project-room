import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { applyJoinSuccessCopy, joinSuccessCopy } from "../src/join.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin, ownerKey };
}

test("join page is public: GET /join and /join/:code serve the page without auth", async t => {
  const { origin } = await serve(t);
  for (const path of ["/join", "/join/", "/join/RM-EXAMPLE", "/room/join", "/room/join/RM-EXAMPLE"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="join-form"/, `${path} has the join form`);
    const formAt = html.indexOf('id="join-form"');
    const permsAt = html.indexOf('id="join-permissions"');
    const detailsPerms = html.indexOf('<details class="join-permissions-details">');
    assert.ok(formAt >= 0 && formAt < permsAt, `${path} name+Join come before the permission list`);
    assert.ok(detailsPerms >= 0 && permsAt > detailsPerms, `${path} permissions sit inside details`);
    assert.match(html, /id="join-consent"/, `${path} has the consent screen`);
    assert.match(html, /id="join-error"/, `${path} has the error screen`);
    // QA 2026-09-29: the /join/ error pages were dead ends with no way back.
    assert.match(html, /id="join-home-link" href="\/(room\/)?"/, `${path} error screen links back to sign-in`);
    assert.match(html, /href="https:\/\/www\.getdasha\.com\/room"/, `${path} error screen links to the marketing page`);
    assert.match(html, /id="join-session-expiry"/, `${path} has the session-expiry line on the success screen`);
    assert.match(html, /src="[^"]*\/src\/join\.js"/, `${path} loads the join script`);
    assert.ok(!html.includes("{{ASSET_BASE}}"), `${path} substitutes the asset base`);
    assert.doesNotMatch(html, /Save your access key too/, `${path} has no agent-key lecture`);
    assert.doesNotMatch(html, /agent tooling, not this browser/, `${path} does not lecture about agent tooling`);
    assert.match(html, /<details class="join-key-details">/, `${path} keeps the agent key in details`);
    const secretAt = html.indexOf('id="join-secret"');
    const detailsAt = html.indexOf('<details class="join-key-details">');
    const detailsEnd = html.indexOf("</details>", detailsAt);
    assert.ok(secretAt > detailsAt && secretAt < detailsEnd, `${path} secret is inside details`);
    assert.doesNotMatch(html, /api\/agents\/enroll/, `${path} noscript does not show agent curl`);
  }
});

test("join page asset base follows the door", async t => {
  const { origin } = await serve(t);
  const root = await (await fetch(`${origin}/join/RM-EXAMPLE`)).text();
  assert.match(root, /src="\/src\/join\.js"/);
  // B1 regression: the stylesheet href must point at the served asset path,
  // not the unserved /styles.css (404 on both doors pre-fix).
  assert.match(root, /href="\/src\/styles\.css"/);
  const door = await (await fetch(`${origin}/room/join/RM-EXAMPLE`)).text();
  assert.match(door, /src="\/room\/src\/join\.js"/);
  assert.match(door, /href="\/room\/src\/styles\.css"/);
});

test("join page assets resolve on both doors (B1+B2)", async t => {
  const { origin } = await serve(t);
  // The exact URLs the rendered join page references must serve 200 with
  // correct content types — through the /room/src/* edge rewrite on the
  // www door twin. Pre-fix: /room/src/join.js 404'd and boot() never ran.
  for (const [path, type] of [
    ["/src/styles.css", /text\/css/],
    ["/src/join.js", /javascript/],
    ["/room/src/styles.css", /text\/css/],
    ["/room/src/join.js", /javascript/],
  ]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} serves`);
    assert.match(res.headers.get("content-type") ?? "", type, `${path} content type`);
  }
});

test("join page route boundaries", async t => {
  const { origin } = await serve(t);
  const post = await fetch(`${origin}/join/RM-EXAMPLE`, { method: "POST" });
  assert.equal(post.status, 405);
  const extra = await fetch(`${origin}/join/RM-EXAMPLE/extra`);
  assert.equal(extra.status, 404);
  const joinHtml = await (await fetch(`${origin}/join.html`)).text();
  assert.match(joinHtml, /id="join-form"/);
  assert.doesNotMatch(joinHtml, /Save your access key too/);
  assert.doesNotMatch(joinHtml, /agent tooling, not this browser/);
  const secretAt = joinHtml.indexOf('id="join-secret"');
  const detailsAt = joinHtml.indexOf('<details class="join-key-details">');
  const detailsEnd = joinHtml.indexOf("</details>", detailsAt);
  assert.ok(secretAt > detailsAt && secretAt < detailsEnd);
  assert.doesNotMatch(joinHtml, /api\/agents\/enroll/);
});

test("full self-serve flow: mint invite, preview the consent screen, join by code", async t => {
  const { origin, ownerKey } = await serve(t);
  const roomId = "commons";
  const minted = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute" }),
  })).json();
  assert.match(minted.code, /^RM-/);

  const preview = await (await fetch(`${origin}/api/agent-invites/preview?code=${minted.code}`)).json();
  assert.equal(preview.roomId, roomId);
  assert.ok(Array.isArray(preview.permissions) && preview.permissions.length > 0);
  assert.ok(preview.expiresAt > Date.now());

  const joined = await (await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Join Page Agent", inviteCode: minted.code }),
  })).json();
  assert.equal(joined.roomId, roomId);
  assert.equal(joined.via, "invite");
  assert.equal(typeof joined.identitySecret, "string");

  // The code is single-use: the join page's consent screen now reports it dead.
  const previewAgain = await fetch(`${origin}/api/agent-invites/preview?code=${minted.code}`);
  assert.equal(previewAgain.status, 409);

  // Raw-code CLI redemption still works on a fresh invite.
  const minted2 = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "chat" }),
  })).json();
  const raw = await (await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: minted2.code, displayName: "CLI Peer" }),
  })).json();
  assert.equal(raw.roomId, roomId);
});

test("join by invite sets a working browser session cookie for the new member", async t => {
  const { origin, ownerKey } = await serve(t);
  const roomId = "commons";
  const minted = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute" }),
  })).json();
  const response = await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Session Agent", inviteCode: minted.code }),
  });
  assert.equal(response.status, 201);
  const joined = await response.json();
  assert.equal(joined.session, true);
  // The join response carries the session row's genuine expiry (8h TTL):
  // the welcome screen renders it as a real date/time, never a guess.
  const eightHours = 8 * 3600 * 1000;
  assert.ok(Number.isSafeInteger(joined.sessionExpiresAt), "join returns sessionExpiresAt");
  assert.ok(joined.sessionExpiresAt > Date.now(), "expiry is in the future");
  assert.ok(joined.sessionExpiresAt <= Date.now() + eightHours + 60_000, "expiry matches the 8h session TTL");
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "join sets a session cookie");
  assert.match(setCookie, /room_session=[^;]+;.*HttpOnly/);
  const cookie = setCookie.split(";")[0];
  // The cookie authenticates the new member: the room snapshot loads as them.
  const snapshot = await (await fetch(`${origin}/api/rooms/${roomId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(snapshot.viewerId, joined.memberId);
  assert.equal(snapshot.state.members[joined.memberId].displayName, "Session Agent");
  // And they can participate: the app fetches its CSRF token from /api/session,
  // then posting a message works through the session like any browser client.
  const sessionView = await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json();
  assert.equal(typeof sessionView.csrf, "string");
  // The expiry the join response reported is the session's real expiry.
  assert.equal(sessionView.expiresAt, joined.sessionExpiresAt);
  const posted = await fetch(`${origin}/api/rooms/${roomId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin, "X-CSRF-Token": sessionView.csrf },
    body: JSON.stringify({ id: "msg-1", type: "message.posted", data: { body: "Hello from the join page" } }),
  });
  assert.equal(posted.status, 201);
});

test("first-room join also signs the browser in", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "First Room Agent" }),
  });
  assert.equal(response.status, 201);
  const joined = await response.json();
  assert.equal(joined.session, true);
  // First-room joins mint the same 8h browser session: the response carries
  // its genuine expiry for the welcome screen.
  assert.ok(Number.isSafeInteger(joined.sessionExpiresAt), "first-room join returns sessionExpiresAt");
  assert.ok(joined.sessionExpiresAt > Date.now(), "expiry is in the future");
  assert.ok(joined.sessionExpiresAt <= Date.now() + 8 * 3600 * 1000 + 60_000, "expiry matches the 8h session TTL");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const snapshot = await (await fetch(`${origin}/api/rooms/${joined.roomId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(snapshot.viewerId, joined.memberId);
});

test("applyJoinSuccessCopy writes joinSuccessCopy onto the success screen", () => {
  const copy = joinSuccessCopy();
  const openEl = { textContent: "Stay" };
  const summary = { textContent: "Lecture" };
  const hint = { textContent: "Long hint" };
  const heading = { childNodes: [{ textContent: "Welcome, " }] };
  const root = {
    getElementById: id => (id === "join-open-room" ? openEl : null),
    querySelector: sel => {
      if (sel === "#join-open-room") return openEl;
      if (sel === "details.join-key-details summary") return summary;
      if (sel === "details.join-key-details .form-hint") return hint;
      if (sel === "#join-success h1") return heading;
      return null;
    }
  };
  assert.deepEqual(applyJoinSuccessCopy(root), copy);
  assert.equal(openEl.textContent, copy.openRoom);
  assert.equal(summary.textContent, copy.keySummary);
  assert.equal(hint.textContent, copy.keyHint);
});
