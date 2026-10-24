import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  readLanesFlag, messageLane, nodeLane, catchUpLine, finishedSince, agentStatusLines,
} from "../src/room-lanes.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => (Object.hasOwn(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

test("lanes stay off until a person turns them on, and the query applies once", () => {
  assert.equal(readLanesFlag("", memoryStorage()), false);
  assert.equal(readLanesFlag("?lanes=0", memoryStorage()), false);
  const storage = memoryStorage();
  assert.equal(readLanesFlag("?lanes=1", storage), true);
  storage.setItem("project-room-lanes", "0");
  assert.equal(readLanesFlag("?lanes=1", storage), false);
});

test("catch-up uses the real finished and needs-you counts", () => {
  assert.equal(catchUpLine({ finished: 0, needsYou: 0 }), "");
  assert.equal(catchUpLine({ finished: 3, needsYou: 0 }), "Since you left: 3 finished.");
  assert.equal(catchUpLine({ finished: 0, needsYou: 1 }), "Since you left: 1 needs you.");
  assert.equal(catchUpLine({ finished: 0, needsYou: 2 }), "Since you left: 2 need you.");
  assert.equal(catchUpLine({ finished: 3, needsYou: 1 }), "Since you left: 3 finished, 1 needs you.");
  assert.equal(catchUpLine({ finished: 3, needsYou: 2 }), "Since you left: 3 finished, 2 need you.");
  const items = [
    { event: { type: T.WORK_COMPLETED } },
    { event: { type: T.WORK_SUPERSEDED } },
    { event: { type: T.MESSAGE_POSTED, data: {} } },
  ];
  assert.equal(finishedSince(items, "viewer"), 2);
});

test("conversation keeps people and agents, and folds system, work, and receipts apart", () => {
  const members = { guide: { id: "guide", system: true, kind: "agent" }, ada: { id: "ada", kind: "agent" } };
  assert.equal(messageLane({ authorId: "ada", body: "hello" }, members), "conversation");
  assert.equal(messageLane({ authorId: "guide", body: "joined" }, members), "system");
  assert.equal(messageLane({ authorId: "ada", kind: "receipt_card" }, members), "receipts");
  assert.equal(messageLane({ authorId: "missing" }, members), "conversation");
  const claim = { hasAttribute: name => name === "data-claim-update", getAttribute: () => null, dataset: {} };
  assert.equal(nodeLane(claim, {}), "system");
  const work = id => ({
    hasAttribute: name => name === "data-work-timeline",
    getAttribute: () => id,
    dataset: {},
  });
  const state = {
    workItems: {
      open: { id: "open", state: "accepted" },
      done: { id: "done", state: "completed", receipt: { eventId: "e1" } },
    },
  };
  assert.equal(nodeLane(work("open"), state), "work");
  assert.equal(nodeLane(work("done"), state), "receipts");
});

test("each active agent has one status line, and system agents stay off it", () => {
  const lines = agentStatusLines({
    zed: { id: "zed", kind: "agent", displayName: "Zed", active: true },
    ada: { id: "ada", kind: "agent", displayName: "Ada", active: true },
    bea: { id: "bea", kind: "human", displayName: "Bea", active: true },
    guide: { id: "guide", kind: "agent", displayName: "Guide", active: true, system: true },
    old: { id: "old", kind: "agent", displayName: "Old", active: false },
  }, { workItems: {} });
  assert.deepEqual(lines.map(line => line.name), ["@Ada", "@Zed"]);
  assert.deepEqual(lines.map(line => line.status), ["Agent", "Agent"]);
  assert.equal(new Set(lines.map(line => line.id)).size, lines.length);
});
