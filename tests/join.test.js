import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJoinCode,
  parseInviteCodeInput,
  joinCodeFromLocation,
  joinCodePath,
  joinRoomHint,
  joinRoomIdFromPath,
  requestDoorRoom,
  serviceApiBase,
  roomEntryHref,
  sameOriginRelativeNext,
  joinNextHref,
  permissionLabel,
  formatInviteExpiry,
  joinErrorMessage,
  validateJoinName,
  apiFetch,
  API_TIMEOUT_MS,
} from "../src/join.js";

test("parse join code from the path, rejecting lookalikes", () => {
  assert.equal(parseJoinCode("/join/RM-ABC123"), "RM-ABC123");
  assert.equal(parseJoinCode("/room/join/RM-ABC123"), "RM-ABC123");
  assert.equal(parseJoinCode("/join/rm-abc123/"), "RM-ABC123");
  assert.equal(parseJoinCode("/join"), null);
  assert.equal(parseJoinCode("/join/"), null);
  assert.equal(parseJoinCode("/join/RM-ABC123/extra"), null);
  assert.equal(parseJoinCode("/join/RM-ABC;DROP"), null);
  assert.equal(parseJoinCode("/rooms/join/RM-ABC123"), null);
  assert.equal(parseJoinCode("/join.html"), null);
  assert.equal(parseJoinCode(null), null);
});

test("a bogus code in the URL is a claim the server judges, not a silent entry form", () => {
  // Regression (bounced PR #3267): the RM- shape gate here swallowed bogus
  // codes, so /join/BOGUS-CODE rendered the code-entry form and the error
  // state never appeared — the a11y browser checks timed out waiting for
  // #join-error. The preview call must see the claim and answer for it.
  assert.equal(parseJoinCode("/join/BOGUS-CODE"), "BOGUS-CODE");
  assert.equal(parseJoinCode("/join/not-a-code"), "NOT-A-CODE");
  assert.equal(joinCodeFromLocation({ pathname: "/join/BOGUS-CODE", search: "" }), "BOGUS-CODE");
});

test("invite code input accepts a bare code or a pasted link, rejecting the rest", () => {
  assert.equal(parseInviteCodeInput("RM-ABC123"), "RM-ABC123");
  assert.equal(parseInviteCodeInput("  rm-abc123  "), "RM-ABC123");
  assert.equal(parseInviteCodeInput("https://room.trydemigod.com/join/RM-ABC123"), "RM-ABC123");
  assert.equal(parseInviteCodeInput("https://www.getdasha.com/room/join/RM-ABC123?next=/offers"), "RM-ABC123");
  assert.equal(parseInviteCodeInput("here's your code: https://room.trydemigod.com/join/RM-ABC123 — good luck"), "RM-ABC123");
  assert.equal(parseInviteCodeInput(""), null);
  assert.equal(parseInviteCodeInput("   "), null);
  assert.equal(parseInviteCodeInput(null), null);
  assert.equal(parseInviteCodeInput("RM-ABC 123"), null);
  assert.equal(parseInviteCodeInput("not a code"), null);
  assert.equal(parseInviteCodeInput("https://room.trydemigod.com/join/not-a-code"), null);
  // The host in a pasted link is ignored — only the code is taken, and it
  // is previewed against this origin before anything joins.
  assert.equal(parseInviteCodeInput("https://other.example/join/RM-ABC123"), "RM-ABC123");
});

test("join code resolution: path wins, ?code= is the fallback", () => {
  assert.equal(joinCodeFromLocation({ pathname: "/join/RM-PATH1", search: "?code=RM-QUERY1" }), "RM-PATH1");
  assert.equal(joinCodeFromLocation({ pathname: "/join", search: "?code=RM-QUERY1" }), "RM-QUERY1");
  assert.equal(joinCodeFromLocation({ pathname: "/room/join", search: "?code=rm-query1" }), "RM-QUERY1");
  assert.equal(joinCodeFromLocation({ pathname: "/join", search: "?code=nope" }), "NOPE");
  assert.equal(joinCodeFromLocation({ pathname: "/join", search: "?code=!!!" }), null);
  assert.equal(joinCodeFromLocation({ pathname: "/join", search: "" }), null);
  assert.equal(joinCodeFromLocation({ pathname: "/join/!!!", search: "" }), null);
});

test("code entry navigates to the canonical code URL on the same door", () => {
  assert.equal(joinCodePath("RM-ABC123", "/join"), "/join/RM-ABC123");
  assert.equal(joinCodePath("RM-ABC123", "/room/join"), "/room/join/RM-ABC123");
  assert.equal(joinCodePath("RM-ABC123", "/room/join/"), "/room/join/RM-ABC123");
});

test("room hint only echoes a plausible room id", () => {
  assert.equal(joinRoomHint("?room=johns-project-room"), "johns-project-room");
  assert.equal(joinRoomHint("?room="), null);
  assert.equal(joinRoomHint(""), null);
  assert.equal(joinRoomHint("?room=<script>"), null);
  assert.equal(joinRoomHint("?room=a/b"), null);
});

test("request-access door room: address fixes it, hint prefills, bare page defaults to the community room", () => {
  assert.deepEqual(requestDoorRoom("/rooms/johns-project-room", ""), { roomId: "johns-project-room", fixed: true });
  assert.deepEqual(requestDoorRoom("/room/rooms/commons", "?room=other"), { roomId: "commons", fixed: true });
  assert.deepEqual(requestDoorRoom("/join", "?room=team-7"), { roomId: "team-7", fixed: false });
  assert.deepEqual(requestDoorRoom("/join", "?room=<script>"), { roomId: "muse-room", fixed: false });
  assert.deepEqual(requestDoorRoom("/join", ""), { roomId: "muse-room", fixed: false });
  assert.deepEqual(requestDoorRoom("/room/join", ""), { roomId: "muse-room", fixed: false });
});

test("room id comes from the /rooms/<id> address the join page is served at", () => {
  assert.equal(joinRoomIdFromPath("/rooms/johns-project-room"), "johns-project-room");
  assert.equal(joinRoomIdFromPath("/rooms/johns-project-room/"), "johns-project-room");
  assert.equal(joinRoomIdFromPath("/room/rooms/commons"), "commons");
  assert.equal(joinRoomIdFromPath("/join"), null);
  assert.equal(joinRoomIdFromPath("/join/RM-ABC123"), null);
  assert.equal(joinRoomIdFromPath("/rooms/"), null);
  assert.equal(joinRoomIdFromPath("/rooms/a/b"), null);
  assert.equal(joinRoomIdFromPath("/rooms/<script>"), null);
  assert.equal(joinRoomIdFromPath(null), null);
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

test("apiFetch bounds every call with a timeout, including the join POST (#2979)", async () => {
  assert.equal(API_TIMEOUT_MS, 10_000);
  // A fetch that stalls forever but, like a real fetch, rejects when its
  // signal aborts. Pre-fix apiFetch passed no signal and had no deadline,
  // so this call would never settle.
  let seenSignal = null;
  const stalledFetch = (url, init = {}) => {
    seenSignal = init.signal ?? null;
    return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const started = Date.now();
  const result = await apiFetch("/api/join", {
    method: "POST",
    data: { displayName: "Stalled", inviteCode: "RM-ABC123" },
    timeoutMs: 25,
    fetchImpl: stalledFetch,
  });
  assert.ok(seenSignal instanceof AbortSignal, "apiFetch passes an AbortSignal to fetch");
  assert.deepEqual(result, { ok: false, status: 0, error: { code: "request_timeout" } });
  assert.ok(Date.now() - started < 5_000, "stalled join resolves at the timeout, not forever");
});

test("apiFetch distinguishes a network failure from a timeout (#2979)", async () => {
  const result = await apiFetch("/api/join", {
    method: "POST",
    data: { displayName: "Offline", inviteCode: "RM-ABC123" },
    timeoutMs: 5_000,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.deepEqual(result, { ok: false, status: 0, error: { code: "network_error" } });
});

test("apiFetch returns the parsed body on success and passes the request through (#2979)", async () => {
  let seen = null;
  const result = await apiFetch("/api/join", {
    method: "POST",
    data: { displayName: "Ada", inviteCode: "RM-ABC123" },
    timeoutMs: 5_000,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 201, json: async () => ({ roomId: "commons" }) };
    },
  });
  assert.deepEqual(result, { ok: true, status: 201, body: { roomId: "commons" } });
  assert.equal(seen.url, "/api/join");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(seen.init.body).displayName, "Ada");
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test("a join timeout names the burned-invite possibility (#2979)", () => {
  const timedOut = joinErrorMessage({ status: 0, code: "request_timeout", action: "join" });
  assert.equal(timedOut.retry, true);
  assert.match(timedOut.title, /timed out/i);
  assert.match(timedOut.message, /already used/i);
  assert.match(timedOut.message, /fresh link/i);
  const previewTimedOut = joinErrorMessage({ status: 0, code: "request_timeout", action: "preview" });
  assert.equal(previewTimedOut.retry, true);
  assert.match(previewTimedOut.title, /couldn't reach/i);
});

test("join names are 1–80 characters", () => {
  assert.equal(validateJoinName("  Muse  "), "Muse");
  assert.equal(validateJoinName(""), null);
  assert.equal(validateJoinName("   "), null);
  assert.equal(validateJoinName("x".repeat(80)), "x".repeat(80));
  assert.equal(validateJoinName("x".repeat(81)), null);
  assert.equal(validateJoinName(null), null);
});
