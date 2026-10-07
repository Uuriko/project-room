// DOOR-LINKS-1: /join exposes same-host /room for "What is Project Room?".
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

test("join page: What is Project Room? is a single door-relative /room link that resolves on both doors", async t => {
  // BUG 2026-10-06: {{ASSET_BASE}}/room rendered as /room/room on the www
  // door (/room/join/...) — a 404. /room is the marketing page on both
  // doors (node server and www edge), so the link must be exactly /room
  // and must resolve 200 wherever the join page was served from.
  const { origin } = await serve(t);
  for (const path of ["/join", "/join/RM-EXAMPLE", "/room/join", "/room/join/RM-EXAMPLE"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /What is Project Room\?/, path);
    assert.match(html, /href="\/room">What is Project Room\?</, `${path} links at exactly /room`);
    assert.ok(!html.includes("/room/room"), `${path} has no /room/room 404 link`);
    const marketing = await fetch(`${origin}/room`);
    assert.equal(marketing.status, 200, `${path} marketing target resolves`);
  }
});
