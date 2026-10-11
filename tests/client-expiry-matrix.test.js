import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

// Methods that rethrow a 401 for their caller to handle (refresh, conversation, replyContext,
// caughtUp, returnBrief, saveHumanPush*) are deliberately not in this table.
// A room credential that dies must end access from EVERY client read and write, not
// only the ones a journey happens to exercise. Each entry calls one RoomClient method
// with a fetcher that answers 401 and expects onAccessEnded exactly once. A method that
// swallows the 401 leaves the page "Connected" over a dead session.
const identity = () => ({ account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding: "session-human" });
const dead = { ok: false, status: 401, json: async () => ({ error: { code: "unauthenticated", message: "Session or key expired or revoked" } }) };
const METHODS = [
  ["send", c => c.send({ id: "cmd-1", type: "message.posted", data: { body: "hi" } })],
  ["reminders", c => c.reminders()],
  ["reports", c => c.reports()],
  ["notifications", c => c.notifications()],
  ["threadMutes", c => c.threadMutes()],
  ["setThreadMute", c => c.setThreadMute("t1", true)],
  ["needsAttention", c => c.needsAttention()],
  ["roomRead", c => c.roomRead("/saved")],
  ["roomWrite", c => c.roomWrite("/saved", { messageId: "m1" })],
  ["charter", c => c.charter(1)],
  ["workResult", c => c.workResult("w1")],
  ["workContext", c => c.workContext("w1")],
  ["humanPushConfig", c => c.humanPushConfig()],
];

for (const [name, call] of METHODS) {
  test(`a 401 on RoomClient.${name} ends access`, async () => {
    let ended = 0;
    const client = new RoomClient({ fetcher: async () => dead, events: class { addEventListener() {} close() {} }, onAccessEnded: () => { ended++; } });
    client.session = identity();
    await Promise.resolve(call(client)).catch(() => {});
    assert.equal(ended, 1, `${name} left a dead session in place`);
    assert.equal(client.session, null);
  });
}
