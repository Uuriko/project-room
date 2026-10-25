import test from "node:test";
import assert from "node:assert/strict";
import { pauseHeaderModel, pauseLineText } from "../src/agent-pause-header.js";

const people = [
  { id: "ada", displayName: "Ada", kind: "agent", active: true },
  { id: "leo", displayName: "Leo", kind: "agent", active: true },
  { id: "mara", displayName: "Mara", kind: "human", active: true },
  { id: "gone", displayName: "Gone", kind: "agent", active: false },
  { id: "old", displayName: "Old", kind: "agent", active: true, identityRevoked: true }
];

test("the header stays quiet until a second click, and it never names an unknown member", () => {
  const paused = [
    { memberId: "ada" },
    { memberId: "mara", pausedAt: 1700000000000 },
    { memberId: "id_hidden", pausedAt: 1700000000000 },
    { memberId: "gone", pausedAt: 1700000000000 }
  ];
  const quiet = pauseHeaderModel({ owner: true, members: people, paused, armed: false });
  assert.equal(quiet.visible, true);
  assert.deepEqual(quiet.targets, []);
  assert.deepEqual(quiet.lines.map(line => line.name), ["Ada", "Mara"]);
  assert.equal(quiet.lines[0].since, null);
  assert.equal(quiet.lines[1].since, 1700000000000);
  assert.equal(JSON.stringify(quiet).includes("id_hidden"), false);

  const armed = pauseHeaderModel({ owner: true, members: people, paused, armed: true });
  assert.deepEqual(armed.targets, ["leo"]);

  const guest = pauseHeaderModel({ owner: false, members: people, paused, armed: true });
  assert.equal(guest.visible, false);
  assert.deepEqual(guest.lines, []);
  assert.deepEqual(guest.targets, []);
});

test("a paused line says until resumed and only uses a time the roster recorded", () => {
  assert.equal(pauseLineText({ name: "Ada", since: null }, () => { throw new Error("invented"); }), "Ada, until resumed");
  assert.equal(pauseLineText({ name: "Mara", since: 1700000000000 }, () => "Nov 14, 3:04 PM"), "Mara, since Nov 14, 3:04 PM, until resumed");
  assert.equal(pauseLineText({ name: "Ada", since: 1700000000000 }, () => ""), "Ada, until resumed");
});
