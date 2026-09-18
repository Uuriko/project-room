import test from "node:test";
import assert from "node:assert/strict";
import {
  roomIdFromHash, selectedRoomFromLocation, publicRoomDeepLink, PUBLIC_ROOM_DOOR,
  roomOpenHandoffHref, authPanelTitle, looksLikeSecretTitle, KEY_KIND_HINT
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

test("roomOpenHandoffHref keeps ?room= and #room/ so Open survives a dropped hash", () => {
  const href = roomOpenHandoffHref(
    "https://project-room-staging.getdasha.workers.dev",
    "#room/grok-muse-potter-20260918",
    "https://www.getdasha.com/room"
  );
  const url = new URL(href);
  assert.equal(url.origin, "https://project-room-staging.getdasha.workers.dev");
  assert.equal(url.searchParams.get("room"), "grok-muse-potter-20260918");
  assert.equal(url.hash, "#room/grok-muse-potter-20260918");
  assert.equal(roomOpenHandoffHref("https://example.com", "#join/x", "https://www.getdasha.com/room"), null);
  assert.equal(roomOpenHandoffHref("https://example.com", "", "https://www.getdasha.com/room"), null);
});

test("auth gate names the room title when known, otherwise the id", () => {
  assert.equal(authPanelTitle("grok-muse-potter-20260918"), "Open room grok-muse-potter-20260918");
  assert.equal(authPanelTitle("commons", "Commons"), "Open Commons");
  assert.equal(authPanelTitle("commons", "pri_secret"), "Open room commons");
  assert.equal(authPanelTitle(null), "Welcome.");
  assert.equal(authPanelTitle("bad id"), "Welcome.");
  assert.match(KEY_KIND_HINT, /Room key opens one room/);
  assert.match(KEY_KIND_HINT, /Account key/);
  assert.equal(looksLikeSecretTitle("Commons"), false);
  assert.equal(looksLikeSecretTitle("pri_secret"), true);
  assert.equal(looksLikeSecretTitle("PRI_secret"), true);
  assert.equal(looksLikeSecretTitle("ga1.guest"), true);
});

test("public deep-link is the getdasha door fragment", () => {
  assert.equal(PUBLIC_ROOM_DOOR, "https://www.getdasha.com/room");
  assert.equal(publicRoomDeepLink("commons"), "https://www.getdasha.com/room#room/commons");
  assert.equal(publicRoomDeepLink("bad id"), "");
});
