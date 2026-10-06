import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

// Authoring-gate answers: typing events arrive on the SSE stream as synthetic
// `typing` events (no id:, so they must not disturb resume); the client must
// surface them via onTyping and throttle outbound heartbeats. No existing
// coverage: the typing surface is new.

const response = (body = {}, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fakeEventSource() {
  const handlers = {};
  const instances = [];
  class Fake {
    constructor(url) {
      this.url = url;
      this.handlers = handlers;
      instances.push(this);
    }
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }
    close() {}
  }
  return {
    Fake,
    instances,
    emit(type, data) { (handlers[type] ?? []).forEach(fn => fn({ data: JSON.stringify(data) })); },
  };
}

const identity = (id = "human") => ({ member: { id }, roomId: "commons", csrf: "x", sessionBinding: "s", authMode: "session" });

test("typing SSE events reach onTyping with parsed typists", () => {
  const { Fake, emit } = fakeEventSource();
  const seen = [];
  const client = new RoomClient({ events: Fake, onTyping: t => seen.push(t), fetcher: async () => response() });
  client.session = identity();
  client.connect();
  emit("typing", { typists: [{ memberId: "a", displayName: "Ava", kind: "human" }] });
  assert.deepEqual(seen, [[{ memberId: "a", displayName: "Ava", kind: "human" }]]);
  client.disconnect();
});

test("non-array typists payloads are ignored", () => {
  const { Fake, emit } = fakeEventSource();
  const seen = [];
  const client = new RoomClient({ events: Fake, onTyping: t => seen.push(t), fetcher: async () => response() });
  client.session = identity();
  client.connect();
  emit("typing", { typists: "not-an-array" });
  emit("typing", {});
  assert.deepEqual(seen, []);
  client.disconnect();
});

test("sendTyping posts once per throttle window", async () => {
  const requests = [];
  const client = new RoomClient({ fetcher: async (url, options) => { requests.push({ url, options }); return response({ ok: true }); } });
  client.session = identity();
  await client.sendTyping();
  await client.sendTyping();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/typing$/);
  assert.equal(requests[0].options.method, "POST");
  client.lastTypingSent = Date.now() - 5000;
  await client.sendTyping();
  assert.equal(requests.length, 2);
});

test("sendTyping without a session does nothing", async () => {
  const requests = [];
  const client = new RoomClient({ fetcher: async url => { requests.push(url); return response(); } });
  await client.sendTyping();
  assert.deepEqual(requests, []);
});

// Instinct-3 (muse-room 3675): typing a private message must not broadcast a
// room-wide typing beat.
test("sendTyping sends no beat while a private recipient is selected", async () => {
  const requests = [];
  const client = new RoomClient({ fetcher: async url => { requests.push(url); return response({ ok: true }); } });
  client.session = identity();
  await client.sendTyping({ toMemberId: "member-b" });
  assert.equal(requests.length, 0);
  assert.equal(client.lastTypingSent ?? 0, 0, "a suppressed beat does not consume the throttle window");
  await client.sendTyping({ toMemberId: "" });
  assert.equal(requests.length, 1);
});

test("the composer passes the private recipient to sendTyping", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /client\.sendTyping\(\{ toMemberId: \$\("#message-to-select"\)\.value \}\)/);
  assert.doesNotMatch(app, /client\.sendTyping\(\)/);
});
