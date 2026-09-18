import test from "node:test";
import assert from "node:assert/strict";
import {
  roomIdFromHash, selectedRoomFromLocation, publicRoomDeepLink, PUBLIC_ROOM_DOOR
} from "../src/room-deep-link.js";

test("roomIdFromHash reads #room/{roomId} and rejects lookalikes", () => {
  assert.equal(roomIdFromHash("#room/grok-muse-potter-20260918"), "grok-muse-potter-20260918");
  assert.equal(roomIdFromHash("#room/commons"), "commons");
  assert.equal(roomIdFromHash("#room-title"), null);
  assert.equal(roomIdFromHash("#pr-record/room/commons"), null);
  assert.equal(roomIdFromHash("#join/abc"), null);
  assert.equal(roomIdFromHash("#room/"), null);
  assert.equal(roomIdFromHash("#room/../x"), null);
  assert.equal(roomIdFromHash(""), null);
});

test("selectedRoomFromLocation prefers #room/{id} over ?room=", () => {
  assert.equal(selectedRoomFromLocation({ search: "?room=lobby", hash: "#room/commons" }), "commons");
  assert.equal(selectedRoomFromLocation({ search: "?room=lobby", hash: "" }), "lobby");
  assert.equal(selectedRoomFromLocation({ search: "room=lobby", hash: "" }), "lobby");
  assert.equal(selectedRoomFromLocation({ search: "?room=a&room=b", hash: "" }), null);
  assert.equal(selectedRoomFromLocation({ search: "", hash: "#room/commons" }), "commons");
});

test("public deep-link is the getdasha door fragment", () => {
  assert.equal(PUBLIC_ROOM_DOOR, "https://www.getdasha.com/room");
  assert.equal(publicRoomDeepLink("commons"), "https://www.getdasha.com/room#room/commons");
  assert.equal(publicRoomDeepLink("bad id"), "");
});
