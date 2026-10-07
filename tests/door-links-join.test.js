// DOOR-LINKS-1: invitation recovery links resolve independently of /room prefix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-door-links-join-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin };
}

test("join page: What is Project Room? links explanatory /about without a doubled room prefix", async t => {
  const { origin } = await serve(t);
  for (const path of ["/join", "/join/RM-EXAMPLE", "/room/join", "/room/join/RM-EXAMPLE"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /What is Project Room\?/, path);
    const expected = "https://room.trydemigod.com/about";
    assert.ok(html.includes(`href="${expected}">What is Project Room?`), path);
    assert.doesNotMatch(html, /href="\/room\/room"/, path);
    const explanationResponse = await fetch(origin+new URL(expected).pathname);
    assert.equal(explanationResponse.status, 200, `${path} information target resolves`);
  }
});
