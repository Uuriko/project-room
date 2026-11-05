import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { boardDeepLinkWanted } from "../src/board-deeplink.js";

test("/r/{room}/board redirects to the app Board deep link instead of 404", async (t) => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.store.close(); try { rmSync(f.directory, { recursive: true, force: true }); } catch {} });
  const o = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/r/commons/board", "/r/commons/board/"]) {
    const r = await fetch(o + path, { redirect: "manual" });
    assert.equal(r.status, 302, path);
    const loc = r.headers.get("location");
    assert.equal(loc, "/?room=commons&board=1");
    assert.ok(boardDeepLinkWanted(loc));
  }
  const head = await fetch(o + '/r/commons/board', { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 302);
  assert.equal(head.headers.get('location'), '/?room=commons&board=1');
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(await head.text(), '');
  const bad = await fetch(o + "/r/Bad_Room/board", { redirect: "manual" });
  assert.notEqual(bad.status, 302);
  const post = await fetch(o + "/r/commons/board", { method: "POST", redirect: "manual" });
  assert.notEqual(post.status, 302);
});
