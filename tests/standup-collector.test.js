// K023: async standup collector. Pure bot tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createStandup, StandupError } from "../server/standup-bot.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof StandupError && error.code === code);

test("setParticipants/submit/missing/digest lifecycle", () => {
  const standup = createStandup();
  standup.setParticipants("2026-09-16", { participantIds: ["ada", "bob"] });
  standup.submit("2026-09-16", { participantId: "ada",
    yesterday: "Shipped auth", today: "Fix bugs", blockers: "Need review" });
  assert.deepEqual(standup.missing("2026-09-16"), ["bob"]);
  const digest = standup.digest("2026-09-16");
  assert.equal(digest.submittedCount, 1);
  assert.equal(digest.blockers.length, 1);
  assert.equal(digest.blockers[0].participantId, "ada");
  assert.ok(Object.isFrozen(digest));
});
test("duplicate submission is refused", () => {
  const standup = createStandup();
  standup.setParticipants("2026-09-16", { participantIds: ["ada"] });
  standup.submit("2026-09-16", { participantId: "ada", yesterday: "x", today: "y" });
  throwsCode(() => standup.submit("2026-09-16", { participantId: "ada", yesterday: "x", today: "y" }),
    "invalid_standup");
});
test("malformed inputs are refused", () => {
  const standup = createStandup();
  throwsCode(() => standup.setParticipants("not-a-date", { participantIds: ["a"] }), "invalid_standup");
});
