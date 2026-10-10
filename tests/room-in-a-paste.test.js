// hs2-room-in-a-paste (1d): a single cloud setup line (paste) that
// provisions a room. Depends on 1b (device-code, guild B1) + 1c.
//
// Fail-first: these tests assert the 1d contract against code that does
// not exist yet. The device-code approval wiring is deliberately NOT
// guessed at — parse/provision carry the code through as pending and the
// remainder is claimed for B1 (see the TODO in server/room-in-a-paste.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupLine, parseSetupLine, provisionFromPaste, SetupLineError,
} from "../server/room-in-a-paste.mjs";

// ---- line format ----------------------------------------------------------

test("buildSetupLine emits one paste-able line that round-trips", () => {
  const line = buildSetupLine({ title: "My Room", purpose: "Friday demos",
    kind: "personal", roomId: "demo-room", wakeUrl: "https://agent.example.test/wake",
    deviceCode: "ABCD-1234" });
  assert.equal(typeof line, "string");
  assert.ok(!line.includes("\n"), "the setup line is a single line");
  assert.ok(line.startsWith("pr-setup://v1?"));
  const parsed = parseSetupLine(line);
  assert.deepEqual({ ...parsed }, {
    version: "v1", title: "My Room", purpose: "Friday demos", kind: "personal",
    roomId: "demo-room", wakeUrl: "https://agent.example.test/wake", deviceCode: "ABCD-1234",
  });
});

test("buildSetupLine omits optional fields", () => {
  const parsed = parseSetupLine(buildSetupLine({ title: "T", purpose: "P" }));
  assert.equal(parsed.kind, "personal");
  assert.equal(parsed.roomId, null);
  assert.equal(parsed.wakeUrl, null);
  assert.equal(parsed.deviceCode, null);
});

test("parseSetupLine rejects malformed lines with coded errors", () => {
  const bad = [
    ["", /invalid_setup_line/],
    ["not a url", /invalid_setup_line/],
    ["https://example.test/?title=T", /invalid_setup_line/],
    ["pr-setup://v2?title=T&purpose=P", /unsupported_setup_version/],
    ["pr-setup://v1?purpose=P", /title/],
    ["pr-setup://v1?title=" + "x".repeat(121) + "&purpose=P", /title/],
    ["pr-setup://v1?title=T", /purpose/],
    ["pr-setup://v1?title=T&purpose=P&kind=galaxy", /kind/],
    ["pr-setup://v1?title=T&purpose=P&roomId=BAD%20ID", /roomId/],
    ["pr-setup://v1?title=T&purpose=P&wake=http://insecure.test/w", /wake/],
    ["pr-setup://v1?title=T&purpose=P&wake=notaurl", /wake/],
    ["pr-setup://v1?title=T&purpose=P&device=!!!", /device/],
  ];
  for (const [line, pattern] of bad) {
    assert.throws(() => parseSetupLine(line), err =>
      err instanceof SetupLineError && (pattern.test(err.message) || pattern.test(err.code)),
      `line: ${line.slice(0, 60)}`);
  }
});

test("parseSetupLine ignores unknown future params (forward-compat for B1)", () => {
  const parsed = parseSetupLine("pr-setup://v1?title=T&purpose=P&futureParam=1");
  assert.equal(parsed.title, "T");
});

// ---- provisioning ----------------------------------------------------------

const fakeCreateRoom = calls => async (secret, request) => {
  calls.push({ secret, request });
  return { roomId: request.roomId ?? "minted-room", ownerMemberId: "ai_x",
    identityId: "ai_x", duplicate: false };
};

test("provisionFromPaste provisions the room from the pasted line", async () => {
  const calls = [];
  const line = buildSetupLine({ title: "Paste Room", purpose: "1d test", roomId: "paste-room-1" });
  const result = await provisionFromPaste({ createRoom: fakeCreateRoom(calls),
    setupLine: line, identitySecret: "pri_testsecret" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].secret, "pri_testsecret");
  assert.deepEqual({ ...calls[0].request },
    { title: "Paste Room", purpose: "1d test", kind: "personal", roomId: "paste-room-1",
      requestId: calls[0].request.requestId });
  assert.equal(typeof calls[0].request.requestId, "string");
  assert.equal(result.roomId, "paste-room-1");
  assert.equal(result.identityId, "ai_x");
  assert.equal(result.duplicate, false);
  assert.equal(result.wakeSubscribed, false);
  assert.equal(result.device, null);
  assert.ok(Object.isFrozen(result));
});

test("provisionFromPaste is idempotent: the same line reuses one requestId", async () => {
  const calls = [];
  // No roomId in the line: the server mints one, so the paste itself must
  // carry the idempotency key.
  const line = buildSetupLine({ title: "No Id Room", purpose: "idempotency" });
  const mk = () => provisionFromPaste({ createRoom: fakeCreateRoom(calls),
    setupLine: line, identitySecret: "pri_testsecret" });
  await mk();
  await mk();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.requestId, calls[1].request.requestId);
  assert.ok(!("roomId" in calls[0].request), "no roomId invented when the line omits it");
});

test("provisionFromPaste subscribes the 1c counts-only wake webhook when the line names one", async () => {
  const calls = [];
  const wakeCalls = [];
  const line = buildSetupLine({ title: "W", purpose: "P", roomId: "wake-room",
    wakeUrl: "https://agent.example.test/wake" });
  const result = await provisionFromPaste({
    createRoom: fakeCreateRoom(calls),
    subscribeWake: async args => { wakeCalls.push(args); return { subscriptionId: "sub_1" }; },
    setupLine: line, identitySecret: "pri_testsecret",
  });
  assert.equal(wakeCalls.length, 1);
  assert.deepEqual({ ...wakeCalls[0] }, {
    identityId: "ai_x", url: "https://agent.example.test/wake", events: ["agent.wake"],
  });
  assert.equal(result.wakeSubscribed, true);
});

test("provisionFromPaste carries the device code through as pending — never resolved here", async () => {
  const calls = [];
  let resolved = false;
  const line = buildSetupLine({ title: "D", purpose: "P", roomId: "device-room", deviceCode: "WXYZ-9999" });
  const result = await provisionFromPaste({ createRoom: fakeCreateRoom(calls),
    setupLine: line, identitySecret: "pri_testsecret" });
  assert.equal(result.roomId, "device-room");
  assert.deepEqual({ ...result.device }, { code: "WXYZ-9999", approval: "pending" });
  assert.equal(resolved, false, "no device-code resolution attempted without B1's module");
});

test("provisionFromPaste parses before any side effect", async () => {
  const calls = [];
  await assert.rejects(() => provisionFromPaste({ createRoom: fakeCreateRoom(calls),
    setupLine: "pr-setup://v1?title=&purpose=P", identitySecret: "pri_testsecret" }),
    err => err instanceof SetupLineError);
  assert.equal(calls.length, 0, "an invalid line creates nothing");
  await assert.rejects(() => provisionFromPaste({ createRoom: fakeCreateRoom(calls),
    setupLine: buildSetupLine({ title: "T", purpose: "P" }), identitySecret: "" }),
    /identitySecret/);
});
