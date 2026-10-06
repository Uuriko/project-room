import test from "node:test";
import assert from "node:assert/strict";
import { leaseHoursFromUntil, parseRoomText } from "../client/text-plug.mjs";
import { holdersForPath, resolveMemberId, swarmBriefFromClaims } from "../client/swarm-brief.mjs";

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

test("playbook progress, handoff, and holders name the claim route fields", () => {
  assert.deepEqual(parseRoomText("PROGRESS backlog-k004-kanban | note: splice landed | room: muse-room"), {
    verb: "progress", workItemId: "backlog-k004-kanban", roomId: "muse-room", note: "splice landed",
  });
  assert.deepEqual(parseRoomText("HANDOFF plan-pr-autolink | to: Jill - Dot | room: muse-room"), {
    verb: "handoff", workItemId: "plan-pr-autolink", to: "Jill - Dot", roomId: "muse-room",
  });
  assert.deepEqual(parseRoomText("holders scripts/runtime-package.mjs | room: muse-room"), {
    verb: "holders", path: "scripts/runtime-package.mjs", roomId: "muse-room",
  });
  assert.deepEqual(parseRoomText("done"), { verb: "done" });
  assert.equal(parseRoomText("DONE backlog-k004-kanban | room: muse-room").verb, "done");
  assert.throws(() => parseRoomText("HANDOFF plan-pr-autolink | mystery: yes"), /invalid_text_plug/);
  assert.throws(() => parseRoomText("PROGRESS backlog-k004-kanban | note: " + "x".repeat(513)), /invalid_text_plug/);
});

test("a claim list names the file two open claims both hold", () => {
  const brief = swarmBriefFromClaims("muse-room", [
    { id: "plan-pr-autolink", state: "claimed", owner: "ai_holder", files: ["scripts/runtime-package.mjs"] },
    { id: "backlog-k004-kanban", state: "in_progress", owner: "ai_other", files: ["scripts/runtime-package.mjs"] },
    { id: "closed", state: "done", owner: "ai_old", files: ["scripts/runtime-package.mjs"] },
  ]);
  assert.equal(brief.open, 2);
  assert.deepEqual(brief.collisions, [{
    file: "scripts/runtime-package.mjs",
    claims: ["backlog-k004-kanban", "plan-pr-autolink"],
    owners: ["ai_holder", "ai_other"],
  }]);
  assert.equal(holdersForPath(brief.collisions, "scripts/runtime-package.mjs").length, 0);
  assert.equal(resolveMemberId([{ id: "ai_holder", displayName: "Jill - Dot", active: true }], "jill - dot"), "ai_holder");
  assert.equal(resolveMemberId([
    { id: "ai_a", displayName: "Jill", active: true },
    { id: "ai_b", displayName: "Jill", active: true },
  ], "Jill"), null);
});

test("claim keeps the work-item id case the room stored", () => {
  assert.deepEqual(parseRoomText("claim ROLE-DRIVER"), { verb: "claim", workItemId: "ROLE-DRIVER" });
  assert.deepEqual(parseRoomText("PR claim JDOT-CLAIM-PR-LINK"), { verb: "claim", workItemId: "JDOT-CLAIM-PR-LINK" });
});
