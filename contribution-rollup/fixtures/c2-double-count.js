import { completeKnownProducer, ownerDecision, proposeReview, verifyPass } from "./helpers.js";
import { c1HappyEvents } from "./c1-happy.js";

/** C2 — same Event ids replayed, then same source + payload under new ids. */
export const c2ReplaySameIds = [...c1HappyEvents, ...c1HappyEvents];

export const c2SamePayloadNewIds = [
  proposeReview(),
  completeKnownProducer(),
  verifyPass(),
  ownerDecision(),
  completeKnownProducer({ id: "evt-work-134-completed-dup", minute: 16 }),
  verifyPass({ id: "evt-work-134-verified-dup", minute: 32 }),
  ownerDecision({ id: "evt-work-134-decided-dup", minute: 41 })
];
