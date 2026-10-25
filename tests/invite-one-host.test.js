// R29-3 (QA loop r141 "two links on two hosts"): on room.trydemigod.com the
// Invite dialog's personal link used the page's own address while "Create
// invite link" used the hard-coded www.getdasha.com/room door, so an owner saw
// two links on two hosts (the door 302s to room.trydemigod.com). The door now
// applies only to the getdasha site, whose root is not the app.
import test from "node:test";
import assert from "node:assert/strict";
import { publicJoinInviteHref, PUBLIC_ROOM_DOOR } from "../src/room-deep-link.js";
import { humanJoinShareUrl } from "../src/share-links.js";

const token = "Q".repeat(43);
const at = (origin, pathname = "/") => ({ origin, pathname, hostname: new URL(origin).hostname });

test("a created link and the personal link share the app's own host", () => {
  const room = at("https://room.trydemigod.com");
  assert.equal(publicJoinInviteHref(token, "", room), `https://room.trydemigod.com/#join/${token}`);
  assert.equal(publicJoinInviteHref(token, "", room), humanJoinShareUrl(token, "", room));
  assert.equal(publicJoinInviteHref(token, "/work/item-1", room), `https://room.trydemigod.com/#join/${token}/work/item-1`);
});

test("the getdasha site still uses the /room door, and non-app pages fall back to it", () => {
  assert.equal(publicJoinInviteHref(token, "", at("https://www.getdasha.com")), `${PUBLIC_ROOM_DOOR}/#join/${token}`);
  assert.equal(publicJoinInviteHref(token, "", at("https://getdasha.com")), `${PUBLIC_ROOM_DOOR}/#join/${token}`);
  assert.equal(publicJoinInviteHref(token, "", at("https://www.getdasha.com", "/room")), `https://www.getdasha.com/room/#join/${token}`);
  assert.equal(publicJoinInviteHref(token, "", at("https://room.trydemigod.com", "/join.html")), `${PUBLIC_ROOM_DOOR}/#join/${token}`);
  assert.equal(publicJoinInviteHref(token, "", at("http://example.test")), `${PUBLIC_ROOM_DOOR}/#join/${token}`, "plain http hosts keep the door");
  assert.equal(publicJoinInviteHref(token), `${PUBLIC_ROOM_DOOR}/#join/${token}`, "no location keeps the door");
});
