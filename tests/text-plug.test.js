import test from "node:test";
import assert from "node:assert/strict";
import { leaseHoursFromUntil, parseRoomText } from "../client/text-plug.mjs";

test("Instinct/Fo one-liners become match or claim", () => {
  assert.deepEqual(parseRoomText("match hobby docs"), { verb: "match", motive: "hobby", tags: ["docs"] });
  assert.deepEqual(parseRoomText("PR claim first-task"), { verb: "claim", workItemId: "first-task" });
  assert.deepEqual(parseRoomText("pull"), { verb: "pull" });
});

test("cash seekers are distinct from hobby", () => {
  assert.equal(parseRoomText("match cash web").motive, "cash");
  assert.equal(parseRoomText("match hobby web").motive, "hobby");
});

test("secrets and unknown verbs fail closed", () => {
  assert.throws(() => parseRoomText("match hobby pri_abcdefghijk"), /secret_in_text/);
  assert.throws(() => parseRoomText("match hobby PRI_abcdefghijk"), /secret_in_text/);
  assert.throws(() => parseRoomText("hello world"), /unknown_text_verb/);
  assert.throws(() => parseRoomText(""), /invalid_text_plug/);
});

test("a playbook CLAIM line names the work item, files, and lease", () => {
  const parsed = parseRoomText("CLAIM fo-matchmaking-land-20261005 | files: server/a.mjs, server/b.mjs | lease until: 2026-10-07T00:00:00Z | not touching: docs/x.md");
  assert.equal(parsed.verb, "claim");
  assert.equal(parsed.workItemId, "fo-matchmaking-land-20261005");
  assert.deepEqual(parsed.files, ["server/a.mjs", "server/b.mjs"]);
  assert.equal(parsed.leaseUntil, "2026-10-07T00:00:00.000Z");
  assert.equal(leaseHoursFromUntil(parsed.leaseUntil, Date.parse("2026-10-06T00:00:00.000Z")), 24);
  assert.throws(() => leaseHoursFromUntil("2099-01-01T00:00:00.000Z", Date.parse("2026-10-06T00:00:00.000Z")), /invalid_text_plug/);
  assert.throws(() => parseRoomText("CLAIM task | files: ../secret"), /invalid_text_plug/);
  assert.throws(() => parseRoomText("CLAIM task | mystery: yes"), /invalid_text_plug/);
});

test("claim keeps the work-item id case the room stored", () => {
  assert.deepEqual(parseRoomText("claim ROLE-DRIVER"), { verb: "claim", workItemId: "ROLE-DRIVER" });
  assert.deepEqual(parseRoomText("PR claim JDOT-CLAIM-PR-LINK"), { verb: "claim", workItemId: "JDOT-CLAIM-PR-LINK" });
});
