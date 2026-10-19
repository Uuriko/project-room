// The standalone agent sign-in page (decision #37): GET /agent-signin
// serves agent-signin.html hosting the same agent-signin UI component
// the login wall used to embed; the wall keeps only a labeled link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-signin-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin };
}

test("agent sign-in page is public: GET /agent-signin and its /room twin serve the page without auth", async t => {
  const { origin } = await serve(t);
  for (const path of ["/agent-signin", "/agent-signin/", "/room/agent-signin"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="agent-signin-ui"/, `${path} hosts the sign-in component`);
    assert.match(html, /id="agent-signin-home"/, `${path} links back to log in`);
    assert.match(html, /src="[^"]*\/src\/agent-signin-page\.js"/, `${path} loads the page script`);
    assert.ok(!html.includes("{{ASSET_BASE}}"), `${path} substitutes the asset base`);
  }
  const roomTwin = await (await fetch(`${origin}/room/agent-signin`)).text();
  assert.match(roomTwin, /href="\/room\/"/, "the /room twin points its home link at the /room door");
});

test("agent sign-in page .html form redirects to the canonical extensionless URL, like /join.html", async t => {
  const { origin } = await serve(t);
  for (const [path, location] of [
    ["/agent-signin.html", "/agent-signin"],
    ["/room/agent-signin.html", "/room/agent-signin"],
    ["/agent-signin.html?next=room", "/agent-signin?next=room"],
  ]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), location, path);
  }
  const head = await fetch(`${origin}/agent-signin.html`, { method: "HEAD", redirect: "manual" });
  assert.equal(head.status, 301);
  assert.equal(head.headers.get("location"), "/agent-signin");
});

test("agent sign-in page route shape: HEAD is empty, POST is refused", async t => {
  const { origin } = await serve(t);
  const head = await fetch(`${origin}/agent-signin`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(`${origin}/agent-signin`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("the login wall links to the agent sign-in page and no longer embeds the step", async t => {
  const { origin } = await serve(t);
  const html = await (await fetch(`${origin}/`)).text();
  assert.match(html, /<a id="agent-signin-button" class="text-button" href="\/agent-signin">Agent sign in<\/a>/);
  assert.ok(!html.includes('id="agent-auth-step"'), "the in-wall agent step is gone");
  assert.ok(!html.includes('id="agent-signin-ui"'), "the wall no longer mounts the component");
});
