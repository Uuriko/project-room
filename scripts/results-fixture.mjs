// Disposable fictional results; no provider reads, execution or publication.
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { rmSync } from "node:fs";

export function createResultsFixture() {
  const f = createAcceptanceFixture();
  const state = () => f.store.room("commons").state;
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const change = (id, type, data = {}, actor = "producer") => send(actor, type, {
    workItemId: id, expectedRevision: state().workItems[id].revision, ...data });
  const create = (id, title, { native = false, gated = false } = {}) => {
    send("owner", T.WORK_PROPOSED, { workItemId: id, title, definitionOfDone: "A useful fictional room result.",
      accountableMemberId: "producer", verifierMemberId: gated ? "reviewer" : null,
      independentVerificationRequired: gated, ownerDecisionRequired: gated, humanDecisionMakerId: gated ? "owner" : null, mode: "read" });
    change(id, T.WORK_ACCEPTED);
    const body = "  Café notes 🪷\n\nOne useful result, with its original spacing.\n";
    const posted = native ? send("producer", T.MESSAGE_POSTED, {
      messageId: id + "-draft", workItemId: id, packetId: id + "-packet", basisRevision: 1, body }) : null;
    change(id, T.WORK_COMPLETED, { summary: title + " — ready to revisit.", nextAction: "Read the result.",
      producerId: "producer",
      ...(native ? { evidenceKind: "room_text", previousCompletionEventId: null, evidenceMessageId: id + "-draft", evidenceMessageEventId: posted.event.id,
        evidenceVersion: textVersion(body) } : { evidenceUrl: "https://example.invalid/fictional-result", evidenceVersion: id + "-v1" }) });
    return body;
  };
  const review = id => {
    const receipt = state().workItems[id].receipt;
    change(id, T.VERIFICATION_RECORDED, { result: "pass", completionEventId: receipt.eventId,
      evidenceVersion: receipt.evidenceVersion, summary: "Checked this exact fictional version." }, "reviewer");
    change(id, T.OWNER_DECISION_RECORDED, { decision: "approved", completionEventId: receipt.eventId,
      evidenceVersion: receipt.evidenceVersion, reason: "Accepted for this fictional room." }, "owner");
  };
  try {
    const body = create("native-result", "Café notes", { native: true });
    create("approved-result", "Launch checklist", { gated: true }); review("approved-result");
    create("pending-result", "Awaiting review", { gated: true });
    return { ...f, state, send, change, create, review, body,
      reopen: id => change(id, T.WORK_BLOCKED, { reason: "A revision is needed.", nextAction: "Revise this result." }) };
  } catch (error) { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); throw error; }
}
