import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_SHA,
  c1HappyEvents,
  c2ReplaySameIds,
  c2SamePayloadNewIds,
  c3ForgedActorEvents,
  c4UnknownProducerEvents,
  ROOM_ID,
  WORK_ITEM_ID
} from "../fixtures/index.js";
import { contributorsForReturnBrief, rollupContributions, UNKNOWN_PRODUCER, WEIGHT_KINDS } from "../src/index.js";

function kindsByMember(rows) {
  const map = {};
  for (const row of rows) {
    map[row.member_id] ||= [];
    map[row.member_id].push(row.kind);
  }
  return map;
}

test("C1 happy rollup: complete + artifact + verify + decide; messages mint nothing", () => {
  const rolled = rollupContributions(c1HappyEvents);
  assert.equal(rolled.rows.length, 4);
  assert.equal(rolled.active_rows.length, 4);
  assert.equal(rolled.gaps.length, 0);
  assert.equal(rolled.active_weight, 4);

  const byMember = kindsByMember(rolled.active_rows);
  assert.deepEqual(byMember.codex.sort(), ["artifact", "complete"]);
  assert.deepEqual(byMember.instinct, ["verify"]);
  assert.deepEqual(byMember.potter, ["decide"]);
  assert.equal(byMember.maya, undefined);

  const complete = rolled.active_rows.find((row) => row.kind === "complete");
  assert.equal(complete.member_id, "codex");
  assert.equal(complete.reported_by, "codex");
  assert.equal(complete.evidence_ref, "evt-work-134-completed");
  assert.equal(complete.room_id, ROOM_ID);
  assert.equal(complete.work_item_id, WORK_ITEM_ID);

  const artifact = rolled.active_rows.find((row) => row.kind === "artifact");
  assert.equal(artifact.member_id, "codex");
  assert.equal(artifact.evidence_ref, ARTIFACT_SHA);

  const verify = rolled.active_rows.find((row) => row.kind === "verify");
  assert.equal(verify.member_id, "instinct");
  assert.equal(verify.reported_by, "instinct");

  const decide = rolled.active_rows.find((row) => row.kind === "decide");
  assert.equal(decide.member_id, "potter");
  assert.equal(decide.reported_by, "potter");

  assert.ok(rolled.active_rows.every((row) => WEIGHT_KINDS.includes(row.kind)));
  assert.ok(rolled.active_rows.every((row) => row.weight > 0));

  const potter = rolled.member_shares.find((share) => share.member_id === "potter");
  assert.equal(potter.member_weight, 1);
  assert.equal(potter.member_share, 0.25);
  assert.ok(!potter.kinds.includes("complete"));

  const brief = contributorsForReturnBrief(c1HappyEvents);
  assert.equal(brief.lines.length, 4);
  assert.equal(brief.gaps.length, 0);
  assert.ok(brief.lines.every((line) => line.source_event_id && line.evidence_ref));
});

test("C1 does not credit proposedById or reporter-as-producer when they differ", () => {
  const events = c1HappyEvents.map((event) => {
    if (event.type !== "work.completed") return event;
    return {
      ...event,
      actorId: "maya",
      data: { ...event.data, producerId: "codex" }
    };
  });
  const rolled = rollupContributions(events);
  const complete = rolled.active_rows.find((row) => row.kind === "complete");
  assert.equal(complete.member_id, "codex");
  assert.equal(complete.reported_by, "maya");
  assert.ok(!rolled.active_rows.some((row) => row.member_id === "maya"));
  assert.ok(!rolled.active_rows.some((row) => row.member_id === "potter" && row.kind !== "decide"));
});

test("C2 double-count: same Event id replay adds no weight", () => {
  const once = rollupContributions(c1HappyEvents);
  const twice = rollupContributions(c2ReplaySameIds);
  assert.equal(twice.rows.length, once.rows.length);
  assert.equal(twice.active_weight, once.active_weight);
  assert.deepEqual(
    twice.active_rows.map((row) => [row.kind, row.member_id, row.evidence_ref]),
    once.active_rows.map((row) => [row.kind, row.member_id, row.evidence_ref])
  );
});

test("C2 double-count: same source + payload under new ids stays one row per kind", () => {
  const rolled = rollupContributions(c2SamePayloadNewIds);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "complete").length, 1);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "artifact").length, 1);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "verify").length, 1);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "decide").length, 1);
  assert.equal(rolled.active_weight, 4);
});

test("C3 forged actor: client actor, label, and prefix mint no share", () => {
  const rolled = rollupContributions(c3ForgedActorEvents);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "verify").length, 0);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "decide").length, 0);
  assert.ok(rolled.active_rows.every((row) => row.member_id === "codex"));
  assert.deepEqual(
    rolled.active_rows.map((row) => row.kind).sort(),
    ["artifact", "complete"]
  );
  assert.ok(!rolled.active_rows.some((row) => row.member_id === "instinct"));
  assert.ok(!rolled.active_rows.some((row) => row.member_id === "maya"));
});

test("C4 unknown producer: no complete/artifact share; gap stays visible", () => {
  const rolled = rollupContributions(c4UnknownProducerEvents);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "complete").length, 0);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "artifact").length, 0);
  assert.ok(!rolled.active_rows.some((row) => row.member_id === "codex"));

  assert.equal(rolled.gaps.length, 1);
  assert.equal(rolled.gaps[0].reason, UNKNOWN_PRODUCER);
  assert.equal(rolled.gaps[0].reported_by, "codex");
  assert.equal(rolled.gaps[0].completion_event_id, "evt-work-134-completed");
  assert.equal(rolled.gaps[0].work_item_id, WORK_ITEM_ID);

  assert.equal(rolled.active_rows.filter((row) => row.kind === "verify")[0]?.member_id, "instinct");
  assert.equal(rolled.active_rows.filter((row) => row.kind === "decide")[0]?.member_id, "potter");

  const brief = contributorsForReturnBrief(c4UnknownProducerEvents);
  assert.equal(brief.gaps.length, 1);
  assert.ok(!brief.lines.some((line) => line.kind === "complete" || line.kind === "artifact"));
});

test("message and ack volume never increases weight", () => {
  const extra = Array.from({ length: 12 }, (_, index) => ({
    id: `evt-spam-${index}`,
    roomId: ROOM_ID,
    type: index % 2 === 0 ? "message.posted" : "message.reaction_set",
    actorId: "maya",
    at: `2026-09-05T10:00:${String(index).padStart(2, "0")}.000Z`,
    data: { body: `noise ${index}`, reaction: "ack", active: true, messageId: "evt-msg-2" }
  }));
  const quiet = rollupContributions(c1HappyEvents);
  const noisy = rollupContributions([...c1HappyEvents, ...extra]);
  assert.equal(noisy.active_weight, quiet.active_weight);
  assert.equal(noisy.rows.length, quiet.rows.length);
});

test("wrong designated verifier or decision-maker earns no share", () => {
  const events = [
    ...c1HappyEvents.filter((event) => event.type !== "verification.recorded" && event.type !== "owner.decision_recorded"),
    {
      id: "evt-wrong-verify",
      roomId: ROOM_ID,
      type: "verification.recorded",
      actorId: "maya",
      at: "2026-09-05T09:30:00.000Z",
      data: {
        workItemId: WORK_ITEM_ID,
        result: "pass",
        completionEventId: "evt-work-134-completed",
        evidenceVersion: ARTIFACT_SHA,
        summary: "Not the designated verifier"
      }
    },
    {
      id: "evt-wrong-decide",
      roomId: ROOM_ID,
      type: "owner.decision_recorded",
      actorId: "maya",
      at: "2026-09-05T09:40:00.000Z",
      data: {
        workItemId: WORK_ITEM_ID,
        decision: "approved",
        completionEventId: "evt-work-134-completed",
        evidenceVersion: ARTIFACT_SHA,
        reason: "Not the designated human"
      }
    }
  ];
  const rolled = rollupContributions(events);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "verify").length, 0);
  assert.equal(rolled.active_rows.filter((row) => row.kind === "decide").length, 0);
});
