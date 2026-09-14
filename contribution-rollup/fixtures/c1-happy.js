import {
  chatter,
  completeKnownProducer,
  ownerDecision,
  proposeReview,
  verifyPass
} from "./helpers.js";

/** C1 — derive complete / artifact / verify / decide from the #134 review fixture. */
export const c1HappyEvents = [
  proposeReview(),
  ...chatter(),
  completeKnownProducer(),
  verifyPass(),
  ownerDecision()
];
