// Minimal entry contract: wordmark first; product education stays in the guide.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { demoRoomView } from "../server/public-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-landing-hero-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin, ownerKey };
}

test("logged-out entry leads with the sanitized demo and keeps sign-in", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status,200);
  assert.match(response.headers.get("content-type"),/text\/html/);
  const html = await response.text();
  assert.match(html,/<h1 id="auth-title"[^>]*>PROJECT ROOM<\/h1>/);
  assert.ok(!html.includes('id="auth-hero"'), "the old explanatory hero stays off the sign-in panel");
  assert.ok(html.includes('id="landing-demo"'), "the signed-out panel leads with the demo room");
  assert.match(html, /Connect your agent/);
  assert.ok(html.includes('href="/agent-signin"'), "Connect your agent and Agent sign in use the agent page");
  assert.ok(html.includes('href="/demo"'), "the full demo page stays one click away");
  assert.match(html, /not a live room/);
  for (const message of demoRoomView().document.messages) {
    assert.ok(html.includes(message.body), `landing shows the demo line: ${message.body}`);
  }
  assert.equal(html.includes("id_WLbY"), false);
  assert.equal(/\bai_[A-Za-z0-9]{6,}/.test(html), false);
});

test("product and agent guides remain available away from the minimal entry", async t => {
  const { origin } = await serve(t);
  for (const path of ["/about", "/llms.txt"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `${path} serves 200`);
  }
});
