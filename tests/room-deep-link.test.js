import test from "node:test";
import assert from "node:assert/strict";
import {
  roomIdFromHash, selectedRoomFromLocation, publicRoomDeepLink, PUBLIC_ROOM_DOOR,
  publicJoinInviteHref, humanJoinShareBase, roomOpenHandoffHref, authPanelTitle, looksLikeSecretTitle, KEY_KIND_HINT,
  roomIdFromNext, ROOM_ACCESS_NOTICE
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

test("roomIdFromNext accepts a room id or a link that already names one", () => {
  assert.equal(roomIdFromNext("commons"), "commons");
  assert.equal(roomIdFromNext("  commons  "), "commons");
  assert.equal(roomIdFromNext("/?room=lobby"), "lobby");
  assert.equal(roomIdFromNext("https://room.example/?room=lobby#room/commons"), "commons");
  assert.equal(roomIdFromNext("https://room.example/#room/commons"), "commons");
  assert.equal(roomIdFromNext("not a room"), null);
  assert.equal(roomIdFromNext(""), null);
  assert.equal(roomIdFromNext("x".repeat(2049)), null);
  assert.equal(ROOM_ACCESS_NOTICE, "You're not in that room yet. Ask a member for an invite, or request to join");
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
  assert.equal(authPanelTitle(null), "Welcome to Project Room");
  assert.equal(authPanelTitle("bad id"), "Welcome to Project Room");
  assert.match(KEY_KIND_HINT, /Room key: one room/);
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

test("human invite URL is the full public #join/ link, never #room/ or RM-", () => {
  const token = "A".repeat(43);
  assert.equal(publicJoinInviteHref(token), `${PUBLIC_ROOM_DOOR}/#join/${token}`);
  assert.equal(
    publicJoinInviteHref(token, "/work/item-1", { hostname: "www.getdasha.com", origin: "https://www.getdasha.com" }),
    `${PUBLIC_ROOM_DOOR}/#join/${token}/work/item-1`
  );
  assert.equal(
    publicJoinInviteHref(token, "", { hostname: "localhost", origin: "http://localhost:52331" }),
    `http://localhost:52331/#join/${token}`
  );
  assert.equal(publicJoinInviteHref("RM-ABC"), "");
  assert.equal(publicJoinInviteHref("short"), "");
  assert.doesNotMatch(publicJoinInviteHref(token), /#room\//);
});

test("human join share URLs keep the app path so www /room is not dropped", () => {
  const token = "T".repeat(43);
  assert.equal(humanJoinShareBase({ origin: "https://www.getdasha.com", pathname: "/room" }), "https://www.getdasha.com/room");
  assert.equal(humanJoinShareBase({ origin: "https://www.getdasha.com", pathname: "/room/" }), "https://www.getdasha.com/room");
  assert.equal(
    publicJoinInviteHref(token, "", { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/room" }),
    `https://www.getdasha.com/room/#join/${token}`
  );
  assert.equal(
    publicJoinInviteHref(token, "", { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/room/" }),
    `https://www.getdasha.com/room/#join/${token}`
  );
  assert.equal(
    publicJoinInviteHref(token, "/work/item-1", { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/room/index.html" }),
    `https://www.getdasha.com/room/#join/${token}/work/item-1`
  );
  assert.equal(
    publicJoinInviteHref(token, "", { hostname: "localhost", origin: "http://localhost:52331", pathname: "/" }),
    `http://localhost:52331/#join/${token}`
  );
  assert.doesNotMatch(
    publicJoinInviteHref(token, "", { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/" }),
    /^https:\/\/www\.getdasha\.com\/#join\//
  );
});
