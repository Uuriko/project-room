// R-16.5 regression: the stream pool is shared server-wide, so admission is
// per-room shared too. Before the fix, members of one room could hold all
// 100 pool slots and every other room's members were refused with
// 429 stream_limit (and so read as absent in presence). Shape mirrors the
// executed repro: fill one room, attempt a stream from a second room,
// read the second member's presence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM_A = "commons", ROOM_B = "annex", ROOM_C = "lookout";

function fixture(t, membersPerRoom) {
  const directory = mkdtempSync(join(tmpdir(), "room-stream-pool-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = {};
  for (const roomId of [ROOM_A, ROOM_B, ROOM_C]) {
    store.initialize(initialRoom(roomId));
    const ownerKey = store.issueAccessKey(roomId, "owner");
    const keys = [];
    for (let i = 0; i < membersPerRoom; i++) {
      const memberId = `${roomId}-${i}`;
      store.command(ownerKey, roomId, { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
      keys.push(store.issueAccessKey(roomId, memberId));
    }
    rooms[roomId] = { ownerKey, keys };
  }
  const server = createRoomServer({ store, streamInterval: 250 });
  return { directory, store, server, rooms,
    close: async () => { server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true }); } };
}

function openRawStream(origin, roomId, key, after = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    socket.once("error", reject);
    let head = "";
    const onData = chunk => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headers = head.slice(0, end);
      const status = Number(headers.slice(9, 12));
      if (status === 200) { socket.off("data", onData); resolve({ socket, status, code: null }); return; }
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
      const body = head.slice(end + 4);
      if (body.length < length) return;
      socket.off("data", onData);
      let code = null;
      try { code = JSON.parse(body).error?.code ?? null; } catch { code = null; }
      resolve({ socket, status, code });
    };
    socket.on("data", onData);
    socket.write(`GET /api/rooms/${roomId}/stream?after=${after} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${key}\r\n\r\n`);
  });
}

// Opens streams for a room until refusal; returns { accepted, rejected, sockets }.
async function fillRoom(origin, roomId, keys, after) {
  const sockets = [];
  let accepted = 0, rejected = 0, rejectCode = null;
  for (const key of keys) for (let s = 0; s < 3; s++) {
    const r = await openRawStream(origin, roomId, key, after);
    if (r.status === 200) { accepted++; sockets.push(r.socket); }
    else { rejected++; rejectCode = `${r.status}:${r.code}`; r.socket.destroy(); }
  }
  return { accepted, rejected, rejectCode, sockets };
}

test("one room cannot starve another: per-room share caps a room at 50 of 100", async t => {
  const fx = fixture(t, 17);
  await new Promise(resolve => fx.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fx.server.address().port}`;
  const sockets = [];
  try {
    const fillA = await fillRoom(origin, ROOM_A, fx.rooms[ROOM_A].keys, fx.store.room(ROOM_A).sequence);
    sockets.push(...fillA.sockets);
    assert.equal(fillA.accepted, 50, "room A holds exactly its 50-stream share");
    assert.equal(fillA.rejected, 1, "room A's 51st stream is refused");
    assert.equal(fillA.rejectCode, "429:stream_limit");

    // The charter's 101st-stream case: a member of a second room still opens
    // a stream while the first room sits at its share.
    const b = await openRawStream(origin, ROOM_B, fx.rooms[ROOM_B].keys[0], fx.store.room(ROOM_B).sequence);
    assert.equal(b.status, 200, "room B member opens a stream despite room A being full");
    sockets.push(b.socket);

    // And presence agrees: the room B member reads as watching/listening,
    // not the absent/unknown it read as under the global-only cap.
    const presenceRes = await fetch(`${origin}/api/rooms/${ROOM_B}/presence`,
      { headers: { Authorization: `Bearer ${fx.rooms[ROOM_B].ownerKey}` } });
    assert.equal(presenceRes.status, 200);
    const row = (await presenceRes.json()).members.find(m => m.memberId === `${ROOM_B}-0`);
    assert.equal(row.watching, true);
    assert.equal(row.state, "listening");

    // A closed stream frees its slot: destroy the room B stream and the
    // same member can reopen (no leaked slot in the per-room count).
    b.socket.destroy();
    let reopened = null;
    for (let attempt = 0; attempt < 100 && !reopened; attempt++) {
      const r = await openRawStream(origin, ROOM_B, fx.rooms[ROOM_B].keys[0], fx.store.room(ROOM_B).sequence);
      if (r.status === 200) reopened = r; else { r.socket.destroy(); await sleep(100); }
    }
    assert.ok(reopened, "a closed stream frees its slot for reopening");
    sockets.push(reopened.socket);
  } finally { for (const s of sockets) s.destroy(); await fx.close(); }
});

test("server-wide ceiling still binds: two full rooms leave no slot for a third", async t => {
  const fx = fixture(t, 17);
  await new Promise(resolve => fx.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fx.server.address().port}`;
  const sockets = [];
  try {
    const fillA = await fillRoom(origin, ROOM_A, fx.rooms[ROOM_A].keys, fx.store.room(ROOM_A).sequence);
    const fillB = await fillRoom(origin, ROOM_B, fx.rooms[ROOM_B].keys, fx.store.room(ROOM_B).sequence);
    sockets.push(...fillA.sockets, ...fillB.sockets);
    assert.equal(fillA.accepted, 50);
    assert.equal(fillB.accepted, 50, "second room can also reach its full share");
    const c = await openRawStream(origin, ROOM_C, fx.rooms[ROOM_C].keys[0], fx.store.room(ROOM_C).sequence);
    assert.equal(c.status, 429, "global 100-stream ceiling still refuses a third room at 100 total");
    assert.equal(c.code, "stream_limit");
    c.socket.destroy();
  } finally { for (const s of sockets) s.destroy(); await fx.close(); }
});
