import {
  chatter,
  completeUnknownProducer,
  ownerDecision,
  proposeReview,
  verifyPass
} from "./helpers.js";

/** C4 — omitted / unknown producerId is a visible gap; reporter is not the producer. */
export const c4UnknownProducerEvents = [
  proposeReview(),
  ...chatter(),
  completeUnknownProducer(),
  verifyPass(),
  ownerDecision()
];
