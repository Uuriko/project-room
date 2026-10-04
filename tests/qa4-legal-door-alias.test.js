// QA4 Q4-H-1 / Q4-H-3: the getdasha door keeps the /room prefix, so /room/<legal page>
// must reach the canonical legal page instead of a 404, and legal pages name one canonical URL.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { LEGAL_SITEMAP_PATHS } from "../server/legal-pages.mjs";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-qa4-legal-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close?.();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("/room/<legal page> redirects to the canonical room-host page", async t => {
  const origin = await serve(t);
  for (const path of [...LEGAL_SITEMAP_PATHS, "/report"]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await fetch(`${origin}/room${path}`, { method, redirect: "manual" });
      assert.equal(res.status, 301, `${method} /room${path}`);
      assert.equal(res.headers.get("location"), `${ROOM_ORIGIN}${path}`);
    }
  }
  const res = await fetch(`${origin}/room/terms?ref=door`, { redirect: "manual" });
  assert.equal(res.headers.get("location"), `${ROOM_ORIGIN}/terms?ref=door`);
});

test("only exact legal paths and safe methods are aliased", async t => {
  const origin = await serve(t);
  for (const path of ["/room/terms/x", "/room/termsx", "/room/api/reports/public"]) {
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.notEqual(res.status, 301, path);
  }
  const post = await fetch(`${origin}/room/terms`, { method: "POST", redirect: "manual", headers: { Origin: origin } });
  assert.notEqual(post.status, 301);
});

test("legal pages carry a canonical Link on the room host", async t => {
  const origin = await serve(t);
  for (const path of LEGAL_SITEMAP_PATHS) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("link"), `<${ROOM_ORIGIN}${path}>; rel="canonical"`);
    await res.arrayBuffer();
  }
});
