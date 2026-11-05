// Agent first-run deep link: the standalone agent sign-in card's board step
// lands in the room with ?board=1 and the wall opens the work board once on
// arrival. Narrow contract tests for the pure helpers (no DOM needed).
import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_DEEP_LINK_PARAM, withBoardDeepLink, boardDeepLinkWanted, stripBoardDeepLink } from "../src/board-deeplink.js";

test("deep link: withBoardDeepLink appends the param to plain and query-bearing targets", () => {
  assert.equal(withBoardDeepLink("/muse-room/"), "/muse-room/?board=1");
  assert.equal(withBoardDeepLink("/muse-room/?room=x"), "/muse-room/?room=x&board=1");
  assert.equal(withBoardDeepLink("/"), "/?board=1");
});

test("deep link: only the exact value 1 is honored", () => {
  assert.equal(BOARD_DEEP_LINK_PARAM, "board");
  assert.equal(boardDeepLinkWanted("?board=1"), true);
  assert.equal(boardDeepLinkWanted("/muse-room/?room=x&board=1"), true);
  assert.equal(boardDeepLinkWanted(""), false);
  assert.equal(boardDeepLinkWanted("/muse-room/"), false);
  assert.equal(boardDeepLinkWanted("?board=0"), false);
  assert.equal(boardDeepLinkWanted("?board=true"), false);
  assert.equal(boardDeepLinkWanted("?board=1&extra=0"), true);
  assert.equal(boardDeepLinkWanted("?Board=1"), false, "param name is case-sensitive");
});

test("deep link: strip removes the param once honored and keeps everything else", () => {
  assert.equal(stripBoardDeepLink("/muse-room/?board=1"), "/muse-room/");
  assert.equal(stripBoardDeepLink("/muse-room/?room=x&board=1"), "/muse-room/?room=x");
  assert.equal(stripBoardDeepLink("/muse-room/?board=1#tasks"), "/muse-room/#tasks");
  assert.equal(stripBoardDeepLink("/muse-room/?board=1&room=x#h"), "/muse-room/?room=x#h");
});

test("deep link: strip is a no-op when the param is absent or misspelled", () => {
  const plain = "/muse-room/?room=x";
  assert.equal(stripBoardDeepLink(plain), plain);
  assert.equal(stripBoardDeepLink("/muse-room/?board=0"), "/muse-room/?board=0", "non-1 values stay in the URL");
  assert.equal(stripBoardDeepLink("https://room.trydemigod.com/muse-room/?board=1"), "https://room.trydemigod.com/muse-room/");
});
