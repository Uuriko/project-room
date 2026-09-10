/** Typed Act-component kinds. Chat reactions are never in this set. */
export const COMPONENT_KINDS = Object.freeze(["approve", "reject", "open_compute", "ack"]);

/** Kinds that record an Act. Open-in-Compute is a deep-link only. */
export const RECORDING_KINDS = Object.freeze(["approve", "reject", "ack"]);

/** v0 proposed-class Events. Later proposal types may join this list. */
export const PROPOSED_CLASS_TYPES = Object.freeze(["work.proposed"]);

export const COMPUTE_ORIGIN = "https://getdasha.com/compute";

export const EVENT_TYPES = Object.freeze({
  MESSAGE_POSTED: "message.posted",
  MESSAGE_REACTION_SET: "message.reaction_set",
  WORK_PROPOSED: "work.proposed",
  OWNER_DECISION_RECORDED: "owner.decision_recorded",
  RECEIPT_RECORDED: "receipt.recorded"
});

/** Intended v26 records. This stub does not write them. */
export const INTENDED_RECORDS = Object.freeze({
  approve: Object.freeze({ type: EVENT_TYPES.OWNER_DECISION_RECORDED, decision: "approved" }),
  reject: Object.freeze({ type: EVENT_TYPES.OWNER_DECISION_RECORDED, decision: "rejected" }),
  ack: Object.freeze({ type: EVENT_TYPES.MESSAGE_POSTED, requestKind: "ack" })
});

export const LABELS = Object.freeze({
  approve: "Approve",
  reject: "Reject",
  open_compute: "Open in Compute",
  ack: "Acknowledge"
});
