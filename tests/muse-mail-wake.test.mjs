import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWakeJournal, validateMuseWakePolicy, wakeOutgoing } from "../scripts/run-muse-mail-wake.mjs";

const connection = { origin: "https://room.example.org", roomId: "demo", memberId: "coordinator" };
const policy = validateMuseWakePolicy({ origin: connection.origin, roomId: connection.roomId, senderMemberId: "coordinator",
  recipientMemberId: "agent", senderEmail: "operator@example.org", museEmail: "agent@muse.ai",
  notBefore: "2026-11-18T19:00:00Z", workItems: ["ready-qa"], requests: ["first"] }, connection);
const request = (id, patch = {}) => ({ id, requesterId: "coordinator", recipientId: "agent",
  openingEventId: "open-" + id, status: "open", workItemId: "ready-qa", createdAt: "2026-11-18T19:01:00Z", ...patch });

test("Muse wake pages authorized requests, rechecks status, and reserves once before sending", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-muse-wake-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = request("first", { workItemId: null }), second = request("second"), waiting = request("waiting");
  const acknowledged = request("acknowledged"), closed = request("closed"), reads = [];
  const client = {
    replyRequests({ cursor }) {
      return cursor ? { evaluatedThrough: 60, requests: [second], page: { hasMore: false } }
        : { evaluatedThrough: 55, requests: [valid, waiting, closed, acknowledged,
          request("old", { createdAt: "2026-11-18T18:59:00Z" }), request("wrong-member", { recipientId: "other" }),
          request("wrong-room-work", { workItemId: "ordinary" })], page: { hasMore: true, nextCursor: "next" } };
    },
    replyContext(id) {
      reads.push(id);
      const row = [valid, second, waiting, closed, acknowledged].find(row => row.id === id);
      return { request: { ...row, ...(id === "closed" ? { status: "answered" } : {}),
        ...(id === "acknowledged" ? { acknowledgedAt: "2026-11-18T19:02:00Z" } : {}) },
      roomCreatedEventId: "room-origin", page: { items: [{ kind: "opened", eventId: row.openingEventId, sequence: 50,
        message: { body: "private work content never goes into email" } }] } };
    }
  };
  const sends = [], events = [];
  const run = () => wakeOutgoing({ client, policy, journal: createWakeJournal(directory),
    async send(message, key) {
      assert.equal(JSON.parse(readFileSync(join(directory, key + ".json"))).state, "attempted");
      assert.equal(message.to, policy.museEmail);
      assert.doesNotMatch(message.text, /private work content/);
      sends.push(message.text);
      if (message.text.includes("exact formal request waiting")) throw Error("lost acknowledgment");
      return { id: "transport-receipt" };
    }, emit: event => events.push(event) });
  assert.equal(await run(), 55);
  assert.equal(await run(), 55);
  assert.deepEqual(reads.slice(0, 5), ["first", "waiting", "closed", "acknowledged", "second"]);
  assert.equal(sends.length, 3);
  assert.deepEqual(events.map(row => row.state), ["mail_accepted", "mail_unconfirmed", "mail_accepted"]);
  const results = readdirSync(directory).map(path => JSON.parse(readFileSync(join(directory, path))).state).sort();
  assert.deepEqual(results, ["attempted", "mail_accepted", "mail_accepted"]);
  assert.throws(() => validateMuseWakePolicy({ ...policy, origin: "https://other.example.org" }, connection), /invalid_local/);
});
