import { completeKnownProducer, event, proposeReview, verifyPass } from "./helpers.js";

/** C3 — client actor, display label, and message prefix must not mint a share. */
export const c3ForgedActorEvents = [
  proposeReview(),
  completeKnownProducer(),
  event(
    "evt-forged-verify",
    "verification.recorded",
    "instinct",
    30,
    {
      workItemId: "work-134-review",
      expectedRevision: 3,
      result: "pass",
      completionEventId: "evt-work-134-completed",
      evidenceVersion: "70053cc6cf9d86f3a43220dcfbb0af05797380c0",
      summary: "Client-claimed PASS",
      claimedActorId: "instinct",
      displayLabel: "[Instinct]"
    },
    { actorProvenance: "client", clientSuppliedActor: true }
  ),
  event("evt-forged-label", "message.posted", "maya", 31, {
    body: "[Instinct] verified 28/28 checks at this revision.",
    workItemId: "work-134-review",
    claimedActorId: "instinct"
  }),
  verifyPass({
    id: "evt-forged-wrong-member",
    actorId: "maya",
    minute: 32
  })
];
