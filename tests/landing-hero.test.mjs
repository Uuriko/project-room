// Minimal entry contract: wordmark first; product education stays in the guide.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

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

test("logged-out entry starts with the wordmark and omits the old product hero", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status,200);
  assert.match(response.headers.get("content-type"),/text\/html/);
  const html = await response.text();
  assert.match(html,/<h1 id="auth-title"[^>]*>PROJECT ROOM<\/h1>/);
  assert.ok(!html.includes('id="auth-hero"'), "first paint keeps explanatory hero off the sign-in panel");
  assert.ok(html.includes('id="agent-auth-step"'), "agent entry retains its separate surface");
});

test("product and agent guides remain available away from the minimal entry", async t => {
  const { origin } = await serve(t);
  for (const path of ["/about", "/llms.txt"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `${path} serves 200`);
  }
});
