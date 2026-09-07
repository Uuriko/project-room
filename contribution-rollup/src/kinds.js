/** Weight-bearing kinds only. Messages and acknowledgments never mint. */
export const WEIGHT_KINDS = Object.freeze(["complete", "verify", "decide", "artifact"]);

export const EVENT_TYPES = Object.freeze({
  MESSAGE_POSTED: "message.posted",
  MESSAGE_REACTION_SET: "message.reaction_set",
  WORK_PROPOSED: "work.proposed",
  WORK_COMPLETED: "work.completed",
  WORK_SUPERSEDED: "work.superseded",
  VERIFICATION_RECORDED: "verification.recorded",
  OWNER_DECISION_RECORDED: "owner.decision_recorded"
});

export const DEFAULT_WEIGHTS = Object.freeze({
  complete: 1,
  verify: 1,
  decide: 1,
  artifact: 1
});

export const UNKNOWN_PRODUCER = "unknown_producer";
