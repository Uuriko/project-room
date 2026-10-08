// W5 boardSeq: the list envelope exposes a monotonic boardSeq (the room
// event sequence — every claim change appends a room event inside the
// write transaction), and ?since= returns 304 when the board is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

const runList = async ({ registry, query = "", sequence = 42 }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({
      ownerId: "owner",
      members: { "agent-a": { id: "agent-a", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] } },
    }),
    room: () => ({ sequence, state: { messages: [] } }),
  };
  const url = { searchParams: new URLSearchParams(query) };
  try {
    await handleWorkClaims({ req: { method: "GET" }, res: {}, url, store, roomId: "room1",
      auth: { member: { id: "agent-a", kind: "agent", permissions: [] } },
      workClaimRoute: "list", helpers, registry });
  } catch (error) {
    return { error, calls: helpers.calls };
  }
  return { error: null, calls: helpers.calls };
};

test("list envelope carries boardSeq", async () => {
  const registry = createWorkClaimRegistry();
  const { error, calls } = await runList({ registry, sequence: 42 });
  assert.equal(error, null);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].value.boardSeq, 42);
});

test("?since= with a current seq returns 304", async () => {
  const registry = createWorkClaimRegistry();
  const { calls } = await runList({ registry, query: "since=42", sequence: 42 });
  assert.equal(calls[0].status, 304);
  assert.equal(calls[0].value.boardSeq, 42);
});

test("?since= with a stale seq returns the full list", async () => {
  const registry = createWorkClaimRegistry();
  const { calls } = await runList({ registry, query: "since=41", sequence: 42 });
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].value.boardSeq, 42);
  assert.ok(Array.isArray(calls[0].value.claims));
});

test("?since= with a malformed value is a 422", async () => {
  const registry = createWorkClaimRegistry();
  const { error } = await runList({ registry, query: "since=abc", sequence: 42 });
  assert.ok(error);
  assert.equal(error.status, 422);
});
