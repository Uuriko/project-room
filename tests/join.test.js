import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJoinCode,
  serviceApiBase,
  roomEntryHref,
  sameOriginRelativeNext,
  joinNextHref,
  permissionLabel,
  formatInviteExpiry,
  joinErrorMessage,
  validateJoinName,
} from "../src/join.js";

test("parse join code from the path, rejecting lookalikes", () => {
  assert.equal(parseJoinCode("/join/RM-ABC123"), "RM-ABC123");
  assert.equal(parseJoinCode("/room/join/RM-ABC123"), "RM-ABC123");
  assert.equal(parseJoinCode("/join/rm-abc123/"), "RM-ABC123");
  assert.equal(parseJoinCode("/join"), null);
  assert.equal(parseJoinCode("/join/"), null);
  assert.equal(parseJoinCode("/join/RM-ABC123/extra"), null);
  assert.equal(parseJoinCode("/join/not-a-code"), null);
  assert.equal(parseJoinCode("/join/RM-ABC;DROP"), null);
  assert.equal(parseJoinCode("/rooms/join/RM-ABC123"), null);
  assert.equal(parseJoinCode("/join.html"), null);
  assert.equal(parseJoinCode(null), null);
});

test("service API base follows the door", () => {
  assert.equal(serviceApiBase("/room/join/RM-ABC"), "/room/api");
  assert.equal(serviceApiBase("/join/RM-ABC"), "/api");
});

test("room entry href preserves the www door", () => {
  assert.equal(
    roomEntryHref("room-1", { origin: "https://www.getdasha.com", pathname: "/room/join/RM-X" }),
    "https://www.getdasha.com/room/#room/room-1"
  );
  assert.equal(
    roomEntryHref("room-1", { origin: "https://room.example", pathname: "/join/RM-X" }),
    "https://room.example/#room/room-1"
  );
});

test("join next follows one same-origin relative path", () => {
  const here = { origin: "https://room.example", pathname: "/join/RM-X", search: "" };
  assert.equal(sameOriginRelativeNext("/offers", here), "/offers");
  assert.equal(sameOriginRelativeNext("/#room/commons?tab=1", here), "/#room/commons?tab=1");
  assert.equal(sameOriginRelativeNext("//evil.example", here), null);
  assert.equal(sameOriginRelativeNext("https://evil.example/phish", here), null);
  assert.equal(sameOriginRelativeNext("/\\evil.example", here), null);
  assert.equal(sameOriginRelativeNext("/ok\nSet-Cookie", here), null);
  assert.equal(joinNextHref("commons", { ...here, search: "?next=https://evil.example" }), "https://room.example/#room/commons");
  assert.equal(joinNextHref("commons", { ...here, search: "?next=/#room/commons" }), "/#room/commons");
});

test("permission labels are human-readable", () => {
  assert.equal(permissionLabel("invite_member"), "Invite members");
  assert.equal(permissionLabel("steer"), "Steer work (claim and direct tasks)");
  assert.equal(permissionLabel("mystery_perm"), "mystery perm");
});

test("expiry formats in plain words", () => {
  const now = 1_000_000;
  assert.equal(formatInviteExpiry(now + 30_000, now), "in less than a minute");
  assert.equal(formatInviteExpiry(now + 5 * 60_000, now), "in 5 minutes");
  assert.equal(formatInviteExpiry(now + 60 * 60_000, now), "in 1 hour");
  assert.equal(formatInviteExpiry(now + 23 * 3_600_000, now), "in 23 hours");
  assert.equal(formatInviteExpiry(now + 3 * 86_400_000, now), "in 3 days");
  assert.equal(formatInviteExpiry(now - 1, now), "expired");
});

test("join errors name the problem and the next step", () => {
  assert.deepEqual(joinErrorMessage({ status: 0 }), { title: "Couldn't reach the room", message: "Check your connection and try again.", retry: true });
  const used = joinErrorMessage({ status: 409, code: "invite_already_used" });
  assert.equal(used.retry, false);
  assert.match(used.message, /fresh link|new one/i);
  assert.match(joinErrorMessage({ status: 410, code: "invite_revoked" }).title, /revoked/i);
  assert.match(joinErrorMessage({ status: 410, code: "invite_expired" }).title, /expired/i);
  assert.match(joinErrorMessage({ status: 409, code: "invite_authority_changed" }).title, /no longer valid/i);
  const linked = joinErrorMessage({ status: 409, code: "identity_already_linked" });
  assert.equal(linked.retry, false);
  assert.equal(linked.title, "Already joined");
  assert.match(linked.message, /sign-in/);
  assert.match(linked.message, /saved agent credential/);
  assert.doesNotMatch(linked.message, /This browser is already/);
  const name = joinErrorMessage({ status: 422, code: "invalid_invite_name", action: "join" });
  assert.equal(name.retry, true);
  assert.match(name.message, /1–80/);
  const preview = joinErrorMessage({ status: 404, code: "invite_unavailable", action: "preview" });
  assert.equal(preview.retry, false);
  assert.match(joinErrorMessage({ status: 500 }).message, /hiccup|try again/i);
});

test("join names are 1–80 characters", () => {
  assert.equal(validateJoinName("  Muse  "), "Muse");
  assert.equal(validateJoinName(""), null);
  assert.equal(validateJoinName("   "), null);
  assert.equal(validateJoinName("x".repeat(80)), "x".repeat(80));
  assert.equal(validateJoinName("x".repeat(81)), null);
  assert.equal(validateJoinName(null), null);
});
