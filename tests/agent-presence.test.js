// B009: agent presence. Pure tracker tests; no realtime wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { createPresence, PresenceError, STATUSES } from "../server/agent-presence.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof PresenceError && error.code === code);

test("heartbeat records status; effective status goes stale to offline", () => {
  const presence = createPresence({ staleAfterMs: 60000 });
  const record = presence.heartbeat("quill", { status: "working", room: "lobby", now: 0 });
  assert.equal(record.status, "working");
  assert.equal(presence.effectiveStatus("quill", { now: 30000 }), "working");
  assert.equal(presence.effectiveStatus("quill", { now: 61000 }), "offline"); // stale
  assert.ok(STATUSES.includes("paused"));
});
test("inRoom lists only fresh, non-offline agents", () => {
  const presence = createPresence({ staleAfterMs: 60000 });
  presence.heartbeat("a", { status: "online", room: "lobby", now: 0 });
  presence.heartbeat("b", { status: "paused", room: "lobby", now: 0 });
  presence.heartbeat("c", { status: "online", room: "other", now: 0 });
  presence.heartbeat("d", { status: "offline", room: "lobby", now: 0 });
  const inLobby = presence.inRoom("lobby", { now: 10000 });
  assert.deepEqual(inLobby.map(r => r.agentId).sort(), ["a", "b"]);
  assert.equal(presence.inRoom("lobby", { now: 70000 }).length, 0); // all stale
  presence.remove("a");
  assert.equal(presence.size(), 3);
});
test("malformed inputs are refused", () => {
  throwsCode(() => createPresence({ staleAfterMs: -1 }), "invalid_presence");
  const presence = createPresence();
  throwsCode(() => presence.heartbeat("", { now: 0 }), "invalid_presence");
  throwsCode(() => presence.heartbeat("x", { status: "sleeping", now: 0 }), "invalid_presence");
  throwsCode(() => presence.effectiveStatus("ghost", { now: 0 }), "invalid_presence");
});
