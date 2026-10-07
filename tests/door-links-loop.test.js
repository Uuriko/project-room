// Wave-2 human-UX (#1602, #1605): door links must offer forward motion.
//
// Contract:
//  - #1602: /about's "Open Project Room" CTA must not be href="/" (which
//    reloads the front door). It points at the room app's start-room intent
//    (/?start=room) — the same main action as the www door's "Start a room"
//    (deploy/room-entry.mjs START_ROOM_URL).
//  - #1605: the no-JS static hero's "Human door" must not point at
//    https://www.trydemigod.com/room, and the www door must not link back
//    into a room-host page that links back to it (no www -> room -> www
//    two-link cycle).
//
// Served bytes are the contract: the server reads these files from disk
// verbatim, so a reintroduced loop fails here exactly when it recurs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ROOM_ENTRY_HTML, START_ROOM_URL } from "../deploy/room-entry.mjs";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";

const WWW_DOOR_URL = "https://www.trydemigod.com/room";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-door-links-loop-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin };
}

const hrefs = html => [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map(m => m[1]);

test("#1602: /about 'Open Project Room' CTA is not href='/'", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/about`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const cta = html.match(/<a class="start" href="([^"]+)">Open Project Room<\/a>/);
  assert.ok(cta, "CTA present on /about");
  assert.notEqual(cta[1], "/", "#1602: the CTA must not reload the front door");
});

test("#1602: /about CTA points at the start-room intent on the same host", async t => {
  const { origin } = await serve(t);
  const html = await (await fetch(`${origin}/about`)).text();
  const cta = html.match(/<a class="start" href="([^"]+)">Open Project Room<\/a>/);
  assert.equal(cta[1], "/?start=room",
    "CTA advances to the room app's start-room intent (src/app.js reads ?start=room)");
});

test("#1605: no www -> room -> www two-link cycle", async t => {
  const { origin } = await serve(t);
  const roomRoot = await (await fetch(`${origin}/`)).text();
  const about = await (await fetch(`${origin}/about`)).text();
  const roomTargets = new Set([...hrefs(roomRoot), ...hrefs(about)]);
  const roomLinksToWwwDoor = [...roomTargets].some(h => h === WWW_DOOR_URL);
  const wwwTargets = hrefs(ROOM_ENTRY_HTML);
  const wwwLinksToRoomHost = wwwTargets.some(h =>
    h === ROOM_ORIGIN || h === START_ROOM_URL || h.startsWith(`${ROOM_ORIGIN}/`));
  assert.ok(wwwLinksToRoomHost, "the www door still offers forward motion into the room");
  assert.ok(!roomLinksToWwwDoor,
    "#1605: no room-host door page links back to the www door (breaks the cycle)");
  assert.ok(!(wwwLinksToRoomHost && roomLinksToWwwDoor),
    "no A->B->A cycle between the www door and the room host");
});

test("#1605: the www door HTML itself has no self-loop to the www door", () => {
  const wwwTargets = hrefs(ROOM_ENTRY_HTML);
  assert.ok(!wwwTargets.includes(WWW_DOOR_URL),
    "the www door must not link back to itself");
  assert.ok(wwwTargets.includes(START_ROOM_URL),
    "the www door keeps its forward-motion main action (Start a room)");
});
